import {
  BUNDLED_GO_GUIDELINES_TAG,
  GO_GUIDELINES_TAG,
  type GoGuidelineSet,
  type GoGuidelinesRefreshOptions,
  bundledGoGuidelines,
  goGuidelineSetOf,
  refreshGoGuidelines,
  storedGoGuidelinesSchema,
} from '@holtkeeper/review'
import type { KvStore, SettingStore } from '@holtkeeper/store'
import { z } from 'zod'

import { type LeaderDuty, periodicDuty } from './leader.ts'

const LATEST_KEY = 'review:go-guidelines:latest'
const tagKey = (tag: string) => `review:go-guidelines:tag:${tag}`
const REFRESH_MS = 23 * 3_600_000
const MAX_PINS = 10

const pinSchema = z.object({
  goGuidelines: z.object({ tag: z.string().regex(GO_GUIDELINES_TAG).optional() }),
})

const storedAt = async (kv: Pick<KvStore, 'get'>, key: string) =>
  storedGoGuidelinesSchema.safeParse(await kv.get(key)).data

/** Release tags pinned by `goGuidelines.tag` in `analyzers.review` entries, at most ten. */
async function pinnedTags(settings: Pick<SettingStore, 'list'>): Promise<string[]> {
  const tags = new Set<string>()
  for (const entry of await settings.list('analyzers.review')) {
    const tag = pinSchema.safeParse(entry.value).data?.goGuidelines.tag
    if (tag && tag !== BUNDLED_GO_GUIDELINES_TAG) tags.add(tag)
  }
  return [...tags].toSorted().slice(0, MAX_PINS)
}

/** What `refreshGoGuidelinesIfDue` reads and writes. */
export interface GoGuidelinesRefreshDeps {
  kv: Pick<KvStore, 'get' | 'set'>
  settings: Pick<SettingStore, 'list'>
  now: Date
  fetch?: GoGuidelinesRefreshOptions['fetch']
  log?: (line: string) => void
}

/**
 * Refreshes the stored modern Go guidelines when the last successful check is older than 23 hours:
 * the newest upstream release, and once each the release tags `analyzers.review` entries pin. A
 * failed refresh keeps the copy stored before (or none, so reviews use the bundled snapshot).
 * Resolves with whether the newest release was checked.
 */
export async function refreshGoGuidelinesIfDue(deps: GoGuidelinesRefreshDeps): Promise<boolean> {
  const { kv, log } = deps
  const previous = await storedAt(kv, LATEST_KEY)
  const due = !previous || deps.now.getTime() - Date.parse(previous.checkedAt) >= REFRESH_MS
  if (due) {
    const result = await refreshGoGuidelines({
      now: deps.now,
      ...(previous ? { previous } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
    if (result.status === 'failed')
      log?.(
        `go guidelines: refresh failed (${result.error}); keeping ${previous ? previous.tag : `the bundled ${BUNDLED_GO_GUIDELINES_TAG}`}`,
      )
    else {
      await kv.set(LATEST_KEY, result.stored)
      log?.(
        result.status === 'updated'
          ? `go guidelines: updated to ${result.stored.tag} (${result.stored.count} guidelines)`
          : `go guidelines: ${result.stored.tag} is current`,
      )
    }
  }
  const latest = due ? await storedAt(kv, LATEST_KEY) : previous
  for (const tag of await pinnedTags(deps.settings)) {
    // oxlint-disable-next-line no-await-in-loop
    if (tag === latest?.tag || (await storedAt(kv, tagKey(tag)))) continue
    // oxlint-disable-next-line no-await-in-loop
    const result = await refreshGoGuidelines({
      tag,
      now: deps.now,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
    if (result.status === 'failed') log?.(`go guidelines: pinned ${tag} failed (${result.error})`)
    else {
      // oxlint-disable-next-line no-await-in-loop
      await kv.set(tagKey(tag), result.stored)
      log?.(`go guidelines: stored pinned ${tag} (${result.stored.count} guidelines)`)
    }
  }
  return due
}

/** The leader duty checking hourly whether the daily guidelines refresh is due. */
export function goGuidelinesDuty(
  deps: Omit<GoGuidelinesRefreshDeps, 'now' | 'kv'> & {
    kv: GoGuidelinesRefreshDeps['kv'] | undefined
    now: () => Date
  },
): LeaderDuty {
  return periodicDuty(
    'go guidelines refresh',
    async () => {
      if (!deps.kv) return
      await refreshGoGuidelinesIfDue({ ...deps, kv: deps.kv, now: deps.now() })
    },
    { intervalMs: 3_600_000, ...(deps.log ? { log: deps.log } : {}) },
  )
}

const setAt = async (kv: Pick<KvStore, 'get'> | undefined, key: string) =>
  kv ? goGuidelineSetOf(await kv.get(key).catch(() => undefined)) : undefined

/**
 * The guidelines a review uses: the stored copy of a pinned `tag` (the bundled snapshot when it is
 * that tag), else the stored newest release, else the bundled snapshot.
 */
export function goGuidelinesSource(
  kv: Pick<KvStore, 'get'> | undefined,
): (tag?: string) => Promise<GoGuidelineSet> {
  return async (tag) => {
    if (tag === BUNDLED_GO_GUIDELINES_TAG) return bundledGoGuidelines()
    const pinned = tag ? await setAt(kv, tagKey(tag)) : undefined
    return pinned ?? (await setAt(kv, LATEST_KEY)) ?? bundledGoGuidelines()
  }
}
