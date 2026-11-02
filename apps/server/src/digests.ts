import { scopeCoversRepo, type Scope } from '@holtkeeper/access'
import type { DigestRun, DigestView } from '@holtkeeper/api'
import {
  type Digest,
  type DigestResult,
  buildDigest,
  describeSchedule,
  digestCard,
  digestDue,
  digestSchema,
  nextDigestRun,
} from '@holtkeeper/digest'
import type { digestInputSchema } from '@holtkeeper/digest'
import type { AnalysisKind } from '@holtkeeper/report'
import { z } from 'zod'

import { chatFor } from './chat.ts'
import { type ServerDeps, repoTarget } from './context.ts'

const LIST_KEY = 'digests'
const runKey = (id: string) => `digest:run:${id}`
const keysKey = (id: string) => `digest:keys:${id}`
const scheduledKey = (id: string) => `digest:scheduled:${id}`
const TICK_MS = 60_000
const ATTEMPTS = 5

const runSchema = z.object({
  at: z.string(),
  status: z.enum(['sent', 'skipped', 'failed']),
  items: z.number(),
  errors: z.array(z.string()),
  manual: z.boolean().optional(),
})

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Who may receive a digest in the panel: only the person saving it may add their own chat. */
export class DigestTargetError extends Error {}

/** Scope in words, for the line under a digest's title. */
function scopeText(scope: Scope): string {
  if (scope.all) return 'All repositories'
  const parts = [
    ...(scope.groups ?? []).map((group) => (Array.isArray(group) ? group.join(' & ') : group)),
    ...(scope.repos ?? []),
  ]
  return parts.length ? parts.join(', ') : 'No repositories'
}

/** Panel targets may only be the caller's own chat, or ones the digest already had. */
const checkTargets = (
  input: z.infer<typeof digestInputSchema>,
  actor: string,
  existing?: Digest,
) => {
  const kept = new Set(
    (existing?.targets ?? []).flatMap((target) => (target.kind === 'panel' ? [target.userId] : [])),
  )
  for (const target of input.targets)
    if (target.kind === 'panel' && target.userId !== actor && !kept.has(target.userId))
      throw new DigestTargetError('only your own panel chat can be added as a target')
}

/**
 * Digests on a server: kept in `store.kv` (`digests`, plus the last run and its item keys per
 * digest), built from the latest analysis records of the scope, delivered as chat cards to Slack
 * channels and panel chats, and sent by `tick` when their schedule is due.
 */
function createDigestService(deps: ServerDeps) {
  const { config, store } = deps
  const memory = new Map<string, unknown>()
  const kv = store.kv ?? {
    get: async (key: string) => memory.get(key),
    set: async (key: string, value: unknown) => void memory.set(key, value),
    delete: async (key: string) => void memory.delete(key),
  }
  const kinds = new Map<string, AnalysisKind>(
    deps.analyses.map((kind) => [kind.kind, kind as AnalysisKind]),
  )
  const base = () => config.server?.publicUrl?.replace(/\/$/, '')

  const list = async (): Promise<Digest[]> => {
    const parsed = z.array(digestSchema).safeParse(await kv.get(LIST_KEY))
    return parsed.success ? parsed.data : []
  }

  const change = async (edit: (digests: Digest[]) => Digest[]) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- retries of one compare-and-set
      const raw = await kv.get(LIST_KEY)
      const parsed = z.array(digestSchema).safeParse(raw)
      const next = edit(parsed.success ? parsed.data : [])
      if (!('compareAndSet' in kv) || !kv.compareAndSet) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt without compare-and-set
        await kv.set(LIST_KEY, next)
        return
      }
      // oxlint-disable-next-line no-await-in-loop -- retries of one compare-and-set
      if (await kv.compareAndSet(LIST_KEY, raw, next)) return
    }
    throw new Error('digests changed too often to save')
  }

  const lastRun = async (id: string): Promise<DigestRun | undefined> => {
    const parsed = runSchema.safeParse(await kv.get(runKey(id)))
    return parsed.success ? parsed.data : undefined
  }

  const view = async (digest: Digest): Promise<DigestView> => {
    const last = await lastRun(digest.id)
    const next = digest.enabled
      ? nextDigestRun(digest.schedule, await scheduledSince(digest))
      : undefined
    return {
      ...digest,
      scheduleText: describeSchedule(digest.schedule),
      ...(next && { nextRun: next.toISOString() }),
      ...(last && { lastRun: last }),
    }
  }

  const create = async (input: z.infer<typeof digestInputSchema>, actor: string) => {
    checkTargets(input, actor)
    const at = deps.now().toISOString()
    const digest: Digest = {
      ...input,
      id: crypto.randomUUID(),
      createdBy: actor,
      createdAt: at,
      updatedAt: at,
    }
    await change((digests) => [...digests, digest])
    return digest
  }

  const update = async (id: string, input: z.infer<typeof digestInputSchema>, actor: string) => {
    const existing = (await list()).find((digest) => digest.id === id)
    if (!existing) return undefined
    checkTargets(input, actor, existing)
    const digest: Digest = { ...existing, ...input, updatedAt: deps.now().toISOString() }
    await change((digests) => digests.map((entry) => (entry.id === id ? digest : entry)))
    return digest
  }

  const remove = async (id: string) => {
    let found = false
    await change((digests) =>
      digests.filter((digest) => {
        if (digest.id === id) found = true
        return digest.id !== id
      }),
    )
    if (found) {
      await kv.delete(runKey(id))
      await kv.delete(keysKey(id))
      await kv.delete(scheduledKey(id))
    }
    return found
  }

  const build = async (
    digest: Pick<Digest, 'id' | 'scope' | 'sections' | 'onlyNew'>,
  ): Promise<{ result: DigestResult; repos: number }> => {
    const sources = new Set(digest.sections.map((section) => section.source))
    const records = (await store.analyses.latest()).filter((record) => sources.has(record.kind))
    const covers = (repo: { forge: string; path: string }) =>
      scopeCoversRepo(digest.scope, repoTarget(config, repo))
    const previous = z.array(z.string()).safeParse(await kv.get(keysKey(digest.id)))
    const result = buildDigest({
      digest,
      records,
      kinds,
      covers,
      ...(previous.success && { previousKeys: new Set(previous.data) }),
      resolveUrl: (href) => {
        if (/^https?:\/\//.test(href)) return href
        const root = base()
        return root && href.startsWith('/') ? `${root}${href}` : undefined
      },
      now: deps.now(),
    })
    const repos = new Set(
      records.filter((record) => covers(record.repo)).map((r) => `${r.repo.forge}:${r.repo.path}`),
    ).size
    return { result, repos }
  }

  const card = (
    digest: Pick<Digest, 'name' | 'onlyNew' | 'scope' | 'schedule'>,
    result: DigestResult,
  ) => {
    const root = base()
    const date = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeZone: digest.schedule.timezone,
    }).format(new Date(result.builtAt))
    return digestCard(digest, result, {
      subtitle: `${scopeText(digest.scope)} · ${date}`,
      ...(root && { url: `${root}/digests` }),
    })
  }

  /** Builds and delivers a digest now; empty ones are skipped unless `manual`. */
  const send = async (digest: Digest, manual = false): Promise<DigestRun> => {
    const { result } = await build(digest)
    const items = result.sections.reduce((sum, section) => sum + section.total, 0)
    const at = deps.now().toISOString()
    let run: DigestRun
    if (result.empty && digest.skipEmpty && !manual) {
      run = { at, status: 'skipped', items, errors: [] }
    } else {
      const message = card(digest, result)
      const chat = chatFor(deps)
      const errors: string[] = []
      let delivered = 0
      for (const target of digest.targets) {
        const surface = chat.surface(target.kind === 'slack' ? 'slack' : 'web')
        try {
          if (!surface) throw new Error('Slack is not configured')
          // oxlint-disable-next-line no-await-in-loop -- a few targets, in order
          await surface.post(
            target.kind === 'slack' ? { channel: target.channel } : { user: target.userId },
            message,
          )
          delivered++
        } catch (error) {
          errors.push(
            `${target.kind === 'slack' ? `#${target.channel}` : 'panel'}: ${messageOf(error)}`,
          )
        }
      }
      run = {
        at,
        status: delivered > 0 || digest.targets.length === 0 ? 'sent' : 'failed',
        items,
        errors,
      }
    }
    if (manual) run.manual = true
    await kv.set(runKey(digest.id), run)
    if (!manual) {
      await kv.set(keysKey(digest.id), result.keys)
      await kv.set(scheduledKey(digest.id), at)
    }
    await store.activity.append({
      at,
      actor: manual ? 'panel' : 'system',
      action: `digest.${run.status}`,
      subject: digest.id,
      details: { name: digest.name, items, ...(run.errors.length && { errors: run.errors }) },
    })
    return run
  }

  /** When the schedule counts from: the last scheduled run or the last change, the later one. */
  const scheduledSince = async (digest: Digest) => {
    const scheduled = z.string().safeParse(await kv.get(scheduledKey(digest.id)))
    const from = scheduled.success ? scheduled.data : digest.updatedAt
    return new Date(Math.max(Date.parse(from), Date.parse(digest.updatedAt)))
  }

  /**
   * Sends every enabled digest whose schedule came due since it last ran on schedule (or was last
   * changed). After downtime a digest goes out once, not once per missed slot; sending from the
   * panel does not move the schedule.
   */
  const tick = async (now = deps.now()) => {
    for (const digest of await list()) {
      if (!digest.enabled) continue
      // oxlint-disable-next-line no-await-in-loop -- digests one after another
      if (!digestDue(digest.schedule, await scheduledSince(digest), now)) continue
      try {
        // oxlint-disable-next-line no-await-in-loop -- digests one after another
        await send(digest)
      } catch (error) {
        console.error(`digests: ${digest.name} failed: ${messageOf(error)}`)
      }
    }
  }

  /** Checks for due digests every minute; returns the stop function. */
  const start = (log: (line: string) => void = console.log) => {
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      tick()
        .catch((error: unknown) => log(`digests: tick failed: ${messageOf(error)}`))
        .finally(() => {
          running = false
        })
    }, TICK_MS)
    return () => clearInterval(timer)
  }

  return { list, view, create, update, remove, build, card, send, tick, start }
}

export type DigestService = ReturnType<typeof createDigestService>

const services = new WeakMap<ServerDeps, DigestService>()

/** The one digest service of a server, shared by routes and the leader's schedule. */
export function digestServiceFor(deps: ServerDeps): DigestService {
  let service = services.get(deps)
  if (!service) {
    service = createDigestService(deps)
    services.set(deps, service)
  }
  return service
}
