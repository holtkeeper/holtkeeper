import { type Principal, type RepoTarget, can } from '@holtkeeper/access'
import { ToolError } from '@holtkeeper/agent-tools'
import type { ReleaseRepoView, ReleaseStepResult } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { createGuideResolver } from '@holtkeeper/guide'
import { type GateResult, GateError } from '@holtkeeper/release'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import { appendAudit } from './audit.ts'
import { type ServerDeps, repoTarget } from './context.ts'
import { releaseServiceFor } from './releases.ts'
import type { ReleaseStepInput, ReleaseToolsAccess } from './tools/releases.ts'
import { canSee } from './visibility.ts'

/** What a step would do, for a confirmation in chat or over MCP. */
export interface ReleaseStepPreview {
  action: ReleaseStepInput['action']
  title: string
  fields: { label: string; value: string }[]
  /** Gates that fail now; soft ones can be overridden. */
  failing: GateResult[]
  /** Why the step cannot run at all; no confirmation is offered then. */
  blocked?: string
  /** The version a deploy starts, resolved from the input or the latest version. */
  tag?: string
}

/** The preview of one step against the current release state. */
export function previewReleaseStep(
  view: ReleaseRepoView,
  input: Pick<ReleaseStepInput, 'action' | 'environment' | 'tag'>,
): ReleaseStepPreview {
  const { path } = view.repo
  const blocked = (title: string, reason: string): ReleaseStepPreview => ({
    action: input.action,
    title,
    fields: [],
    failing: [],
    blocked: reason,
  })
  if (view.row.mode === 'external')
    return blocked(`Release ${path}`, 'Another tool releases this repository.')
  if (input.action === 'propose') {
    const plan = view.proposal
    if (!plan)
      return blocked(
        `Open the release candidate of ${path}`,
        view.settings.flow.mode === 'merge-request'
          ? `Nothing on ${view.settings.flow.source} waits for a release candidate.`
          : 'The flow has no release candidate merge request.',
      )
    return {
      action: 'propose',
      title: `${view.row.request ? `Update !${view.row.request.id}` : 'Open the release candidate'} of ${path}${plan.version ? ` for ${plan.version}` : ''}`,
      fields: [
        { label: 'Changes', value: String(plan.entries.filter((entry) => entry.included).length) },
        { label: 'Range', value: `${plan.range.fromLabel ?? 'start'} → ${plan.range.toLabel}` },
      ],
      failing: plan.gates.filter((gate) => !gate.ok),
    }
  }
  if (input.action === 'accept' || input.action === 'version') {
    const plan = view.version
    if (!plan)
      return blocked(
        `${input.action === 'accept' ? 'Accept' : 'Create a version of'} ${path}`,
        'Nothing on the target branch waits for a version.',
      )
    if (input.action === 'accept')
      return {
        action: 'accept',
        title: `Accept ${plan.range.toLabel} of ${path} for ${plan.tag ?? plan.version ?? 'the next version'}`,
        fields: [
          {
            label: 'Changes',
            value: String(plan.entries.filter((entry) => entry.included).length),
          },
        ],
        failing: [],
      }
    return {
      action: 'version',
      title: `Create ${plan.tag ?? plan.version ?? 'a version'} of ${path}?`,
      fields: [
        { label: 'Changes', value: String(plan.entries.filter((entry) => entry.included).length) },
        { label: 'Range', value: `${plan.range.fromLabel ?? 'start'} → ${plan.range.toLabel}` },
      ],
      failing: plan.gates.filter((gate) => !gate.ok),
    }
  }
  const environment = input.environment
  if (!environment) return blocked(`Deploy ${path}`, 'Name the environment.')
  if (!view.settings.deploy.environments.some((env) => env.name === environment))
    return blocked(
      `Deploy ${path} to ${environment}`,
      `No environment ${environment}; configured: ${view.settings.deploy.environments.map((env) => env.name).join(', ') || 'none'}.`,
    )
  const tag = input.tag ?? view.deploy?.tag
  if (!tag)
    return blocked(`Deploy ${path} to ${environment}`, `${path} has no version to deploy yet.`)
  const state =
    view.deploy?.tag === tag
      ? view.deploy.environments.find((env) => env.name === environment)
      : undefined
  return {
    action: 'deploy',
    title: `Deploy ${tag} of ${path} to ${environment}?`,
    fields: state ? [{ label: 'Now', value: state.status }] : [],
    failing:
      state?.status === 'waiting' && state.after
        ? [{ id: 'order', ok: false, message: `${state.after} is not deployed yet` }]
        : [],
    tag,
  }
}

/** What of a plan a confirmation depends on. */
const planSnapshot = (step: ReleaseRepoView['proposal']) =>
  step && {
    version: step.version,
    range: step.range,
    entries: step.entries.filter((entry) => entry.included).map((entry) => entry.id),
  }

/** What a preview depends on; a confirmation is refused once it changes. */
function snapshotOf(view: ReleaseRepoView, preview: ReleaseStepPreview): string {
  const state = JSON.stringify({
    stage: view.row.stage,
    latest: view.row.latest?.tag,
    request: view.row.request?.id,
    accepted: view.row.acceptance?.sha,
    proposal: preview.action === 'propose' ? planSnapshot(view.proposal) : undefined,
    version:
      preview.action === 'version' || preview.action === 'accept'
        ? planSnapshot(view.version)
        : undefined,
    deploy:
      preview.action === 'deploy' && view.deploy && view.deploy.tag === preview.tag
        ? view.deploy.environments.map((env) => [env.name, env.status])
        : undefined,
  })
  return new Bun.CryptoHasher('sha256').update(state).digest('hex')
}

const CONFIRM_TTL_SECONDS = 600

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const confirmationSchema = z.object({
  principal: z.string(),
  repo: z.string(),
  action: z.enum(['propose', 'accept', 'version', 'deploy']),
  environment: z.string().optional(),
  tag: z.string().optional(),
  override: z.boolean(),
  writeNotes: z.boolean(),
  note: z.string().optional(),
  snapshot: z.string(),
  expiresAt: z.string(),
})

type Confirmation = z.infer<typeof confirmationSchema>

const confirmKey = (token: string) => `release:confirm:${token}`

/** In-memory stand-in for `Store.kv`; expiry is checked against `expiresAt`. */
function memoryKv(): Pick<KvStore, 'get' | 'set' | 'compareAndSet'> {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    compareAndSet: async (key, expected, value) => {
      if (JSON.stringify(values.get(key)) !== JSON.stringify(expected)) return false
      values.set(key, value)
      return true
    },
  }
}

const CONSUMED = { consumed: true }

async function takeConfirmation(
  kv: Pick<KvStore, 'get' | 'compareAndSet'>,
  token: string,
): Promise<unknown> {
  const key = confirmKey(token)
  const raw = await kv.get(key)
  if (raw === undefined || !kv.compareAndSet) return undefined
  return (await kv.compareAndSet(key, raw, CONSUMED, CONFIRM_TTL_SECONDS)) ? raw : undefined
}

/** Options of `releaseToolsAccess`. */
export interface ReleaseToolsAccessOptions {
  /** Who acts: an MCP caller, or a pseudo principal for internal agents. */
  principal: Principal
  /** Whether the caller may read the release state of a configured repository. */
  canRead: (repo: RepoTarget) => boolean
  /**
   * Offer `release_step`: only for MCP tokens with the `release` scope. Each call still needs
   * `releases:run` on the repository and a repository Holtkeeper may write to.
   */
  steps?: boolean
  /** The channel steps are recorded with, e.g. `mcp`. */
  channel: string
}

/**
 * What the `releases` toolset reads and runs for one caller, over the server's release service:
 * settings, the Guide's `releases` section, status, changes, and with `steps` previews that hand
 * out a one-time confirm token (10 minutes, bound to the caller, the arguments and the release
 * state) and runs that redeem it. Successful steps are recorded (history and audit) with
 * `channel`; refused runs are audited as denied or failed.
 */
export function releaseToolsAccess(
  deps: ServerDeps,
  options: ReleaseToolsAccessOptions,
): ReleaseToolsAccess {
  const { config, store } = deps
  const releases = releaseServiceFor(deps)
  const resolveGuide = createGuideResolver({ store })
  const kv = store.kv ?? memoryKv()
  const { principal } = options

  const repoOf = (value: string): RepoRef | undefined => {
    const separator = value.indexOf(':')
    if (separator < 1 || separator === value.length - 1) return undefined
    const repo = { forge: value.slice(0, separator), path: value.slice(separator + 1) }
    if (!config.forges[repo.forge]) return undefined
    return options.canRead(repoTarget(config, repo)) ? repo : undefined
  }

  const audit = async (
    repo: RepoRef,
    input: ReleaseStepInput,
    outcome: 'denied' | 'error',
    reason: string,
  ) =>
    appendAudit(store, {
      at: deps.now().toISOString(),
      actor: { id: principal.id, name: principal.name, provider: principal.provider },
      via: 'api',
      action: `release.${input.action}`,
      target: { type: 'release', repo: keyOf(repo) },
      outcome,
      details: { channel: options.channel, reason },
    })

  const runnable = async (repo: RepoRef, input: ReleaseStepInput) => {
    if (!can(principal, 'releases:run', { kind: 'repo', repo: repoTarget(config, repo) })) {
      await audit(repo, input, 'denied', 'missing releases:run')
      throw new ToolError(`You may not run release steps of ${keyOf(repo)}.`)
    }
    if (await releases.isReadOnly(repo)) {
      await audit(repo, input, 'denied', 'repository is read-only')
      throw new ToolError(`${keyOf(repo)} is read-only for Holtkeeper.`)
    }
  }

  const steps: ReleaseToolsAccess['steps'] = options.steps
    ? {
        async preview(repo, input) {
          await runnable(repo, input)
          const view = await releases.view(principal, repo)
          const preview = previewReleaseStep(view, input)
          if (preview.blocked) return { preview }
          const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString(
            'base64url',
          )
          const confirmation: Confirmation = {
            principal: principal.id,
            repo: keyOf(repo),
            action: input.action,
            ...(input.environment ? { environment: input.environment } : {}),
            ...(preview.tag ? { tag: preview.tag } : {}),
            override: input.override ?? false,
            writeNotes: input.writeNotes ?? false,
            ...(input.note ? { note: input.note } : {}),
            snapshot: snapshotOf(view, preview),
            expiresAt: new Date(deps.now().getTime() + CONFIRM_TTL_SECONDS * 1000).toISOString(),
          }
          await kv.set(confirmKey(token), confirmation, CONFIRM_TTL_SECONDS)
          return { preview, confirm: token }
        },

        async run(repo, input, token): Promise<ReleaseStepResult> {
          await runnable(repo, input)
          const parsed = confirmationSchema.safeParse(await takeConfirmation(kv, token))
          const stored = parsed.success ? parsed.data : undefined
          const matches =
            stored !== undefined &&
            stored.expiresAt > deps.now().toISOString() &&
            stored.principal === principal.id &&
            stored.repo === keyOf(repo) &&
            stored.action === input.action &&
            stored.environment === input.environment &&
            (input.tag === undefined || stored.tag === input.tag) &&
            stored.override === (input.override ?? false) &&
            stored.writeNotes === (input.writeNotes ?? false) &&
            stored.note === input.note
          if (!stored || !matches) {
            await audit(
              repo,
              input,
              'denied',
              'confirm token unknown, expired or for other arguments',
            )
            throw new ToolError(
              'The confirm token is unknown, expired or was issued for other arguments. Call release_step without confirm to preview again.',
            )
          }
          const view = await releases.view(principal, repo)
          const preview = previewReleaseStep(view, {
            ...input,
            ...(stored.tag ? { tag: stored.tag } : {}),
          })
          if (preview.blocked || snapshotOf(view, preview) !== stored.snapshot) {
            await audit(repo, input, 'denied', 'release state changed since the preview')
            throw new ToolError(
              `The release state of ${keyOf(repo)} changed since the preview${preview.blocked ? `: ${preview.blocked}` : ''}. Preview again.`,
            )
          }
          const actor = { id: principal.id, name: principal.name, channel: options.channel }
          try {
            if (stored.action === 'propose')
              return await releases.propose(repo, actor, stored.override, stored.writeNotes)
            if (stored.action === 'accept') return await releases.accept(repo, actor, stored.note)
            if (stored.action === 'version')
              return await releases.version(repo, actor, stored.override)
            return await releases.deploy(
              repo,
              {
                tag: stored.tag!,
                environment: stored.environment!,
                ...(stored.override ? { force: true } : {}),
              },
              actor,
            )
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await audit(repo, input, 'error', message)
            if (error instanceof GateError)
              throw new ToolError(
                `Gates failed: ${error.gates.map((gate) => gate.message).join('; ')}. Pass override only if the user asked to.`,
              )
            throw new ToolError(message)
          }
        },
      }
    : undefined

  return {
    repoOf,
    settings: (repo) => releases.settingsOf(repo),
    guide: async (repo) =>
      (
        await resolveGuide({
          repo: repoTarget(config, repo),
          task: 'release-notes',
          notesChars: 0,
        })
      ).text.trim(),
    status: (repo) => releases.view(principal, repo),
    changes: (repo, range) => releases.changes(repo, range),
    ...(steps ? { steps } : {}),
  }
}

const agentPrincipal: Principal = { id: 'agent', name: 'agent', provider: 'agent', grants: [] }

/**
 * Read-only release tools for an internal agent working on `repo`: the release state of that
 * repository and of repositories sharing a group with it, narrowed to what `requester` may
 * `releases:read` when a person asked. No steps, and never who accepted a release.
 */
export function agentReleaseAccess(
  deps: ServerDeps,
  repo: RepoTarget,
  requester?: Principal,
): ReleaseToolsAccess {
  const access = releaseToolsAccess(deps, {
    principal: agentPrincipal,
    canRead: (other) =>
      ((other.forge === repo.forge && other.path === repo.path) ||
        other.groups.some((group) => repo.groups.includes(group))) &&
      (!requester || canSee(requester, 'releases:read', other)),
    channel: 'agent',
  })
  return { ...access, anonymous: true }
}
