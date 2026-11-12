import { can, type Principal } from '@holtkeeper/access'
import type {
  ReleaseBoardRow,
  ReleaseCard,
  ReleaseDetectView,
  ReleaseOverview,
  ReleaseRepoView,
  ReleaseStepResult,
  ReleaseTimelineView,
  ReleaseVersionDeploy,
  ReleaseVersionView,
} from '@holtkeeper/api'
import { type HoltkeeperConfig, rootGroups } from '@holtkeeper/core'
import type { ForgeEvent, GitForge, RepoRef } from '@holtkeeper/forge'
import { type Issue, issuesByKey } from '@holtkeeper/issues'
import { groupRepositories } from '@holtkeeper/jobs'
import {
  type Acceptance,
  type DeployState,
  type ReleaseEdits,
  type ReleaseEvent,
  type ReleaseFacts,
  type ReleaseNotifySettings,
  type ReleaseActor,
  type RangeChanges,
  type ReleasePlan,
  type ReleaseSettings,
  type VersionTag,
  acceptanceLabel,
  acceptanceSchema,
  announce,
  boardRow,
  collectFacts,
  createVersion,
  deployFinished,
  deployWatchMinutes,
  detectRepositoryFlow,
  pendingStep,
  planRelease,
  proposeRelease,
  rangeChanges,
  readDeployState,
  readStored,
  refreshProposal,
  releaseLinks,
  releaseEditsSchema,
  releaseEventSchema,
  releaseNotifySchema,
  releaseNotifySettingKey,
  releaseSettings,
  releaseSettingsKey,
  startDeploy,
  timelineVersions,
  versionDetail,
  versionTags,
  versionProvenance,
  versionTimeline,
  withDeployActors,
  withIssues,
  writeSummary,
  forgeLinks,
  isValidVersion,
  versionOfTag,
} from '@holtkeeper/release'
import { resolveSetting } from '@holtkeeper/settings'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import { appendAudit } from './audit.ts'
import { type ServerDeps, repoTarget } from './context.ts'
import { issueTrackerFor } from './issues.ts'
import { peopleOf } from './routes/avatars.ts'

const HISTORY = 100
const BOARD_CONCURRENCY = 4
const BOARD_REFRESH_MS = 30 * 60_000
const BOARD_REFRESHING_SECONDS = 15 * 60
const REFRESH_DELAY_MS = 30_000
const TAG_PAGE = 100
const TAG_MAX = 3200
const TAGS_TTL_SECONDS = 30 * 60
const TIMELINE_LIMIT = 30

const BOARD_INDEX = 'release:board:index'
const BOARD_REFRESHING = 'release:board:refreshing'

type Step = 'propose' | 'version'

/** The changes between two refs of a repository, as `release_changes` shows them. */
export interface ReleaseChanges extends RangeChanges {
  repo: RepoRef
  /** Exclusive start: a version tag, or absent for the whole history. */
  from?: string
  /** The end: a version tag, or the target branch for the next release. */
  to: string
  /** `to` is the target branch: these changes wait for the next version. */
  unreleased: boolean
  compareUrl?: string
}

const repoKeyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Whether a person changed a plan beyond accepting its suggestions. */
const edited = (edits: ReleaseEdits) =>
  edits.version !== undefined ||
  edits.title !== undefined ||
  (edits.excluded?.length ?? 0) > 0 ||
  (edits.included?.length ?? 0) > 0 ||
  Object.keys(edits.texts ?? {}).length > 0 ||
  edits.summary?.source === 'person'

/** In-memory stand-in for `Store.kv` on servers without one; expiry is ignored. */
function memoryKv(): Pick<KvStore, 'get' | 'set' | 'delete'> {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  }
}

/** Steps or deploys wait on a person: the most advanced stage is pending, or a deploy failed or waits. */
const needsAction = (row: ReleaseBoardRow) =>
  row.error !== undefined ||
  row.stage === 'awaiting-version' ||
  row.stage === 'proposed' ||
  row.stage === 'candidate' ||
  (row.deploy?.environments.some((env) => env.status === 'failed' || env.status === 'ready') ??
    false)

/**
 * Whether a release waits for an acceptance nobody gave: the flow asks for one, the target branch
 * has unreleased commits and its head is not accepted. An open candidate merge request alone does
 * not count: an acceptance names the target head, so it is possible only once the changes landed.
 * The only release state that is a decision for a person.
 */
export const awaitsAcceptance = (row: ReleaseBoardRow) =>
  row.error === undefined &&
  row.stage !== 'external' &&
  row.acceptanceRequired &&
  row.acceptance === undefined &&
  row.unreleased > 0

/**
 * What `principal` may do with a repository's release, as `ReleaseCard.can`: both need exactly
 * `releases:run` on the repository and a repository that is not read-only, `accept` also changes
 * on the target branch that wait for a version, a flow that asks for an acceptance and no
 * acceptance yet. Nothing without a principal.
 */
export function releaseCan(
  config: HoltkeeperConfig,
  principal: Principal | undefined,
  row: ReleaseBoardRow,
  readOnly = false,
): ReleaseCard['can'] {
  const run =
    !readOnly &&
    principal !== undefined &&
    can(principal, 'releases:run', { kind: 'repo', repo: repoTarget(config, row.repo) })
  return { accept: run && awaitsAcceptance(row), run }
}

/** The commit a decision about the waiting release names, as `ReleaseCard.head`. */
const waitingHead = (row: ReleaseBoardRow, facts: ReleaseFacts) => {
  if (row.error !== undefined || !needsAction(row)) return undefined
  return row.stage === 'candidate' || row.stage === 'proposed'
    ? facts.source?.sha
    : facts.target.sha
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      // oxlint-disable-next-line no-await-in-loop -- a bounded pool of workers
      results[index] = await map(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const key = (kind: string, repo: RepoRef) => `release:${kind}:${repoKeyOf(repo)}`

const repoSchema = z.object({ forge: z.string(), path: z.string() })

/** Whether a stored row was read under another flow mode or acceptance mode than `settings`. */
const staleFor = (stored: BoardRead, settings: ReleaseSettings) =>
  stored.row.error === undefined &&
  (stored.row.mode !== settings.flow.mode ||
    (stored.acceptanceMode !== undefined && stored.acceptanceMode !== settings.acceptance))
const boardIndexSchema = z.object({ repos: z.array(repoSchema), readAt: z.string() })
const storedRowSchema = z.object({
  readAt: z.string(),
  head: z.string().optional(),
  acceptanceMode: z.string().optional(),
  row: z.custom<ReleaseBoardRow>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'repo' in value &&
      'stage' in value &&
      'environments' in value,
  ),
})
const dismissalSchema = z.object({ sha: z.string(), by: z.string(), at: z.string() })
type Dismissal = z.infer<typeof dismissalSchema>
type BoardRead = { row: ReleaseBoardRow; head?: string; acceptanceMode?: string }
const tagsSchema = z.object({
  tags: z.array(
    z.object({
      name: z.string(),
      sha: z.string(),
      committedAt: z.string().optional(),
      createdAt: z.string().optional(),
    }),
  ),
  complete: z.boolean(),
})

type StoredTags = z.infer<typeof tagsSchema>

/**
 * Whether `before` is dated no later than `tag`. Tags are read newest commit first, so a partial
 * list whose version before `tag` is also older by date is unlikely to still miss one between
 * them; a maintenance tag dated after `tag` is not proof.
 */
const datedBefore = (before: VersionTag, tag: VersionTag) =>
  !before.date || !tag.date || Date.parse(before.date) <= Date.parse(tag.date)

/** Whether `versions` hold `ref` (a version tag or version) and the shown version before it. */
const knowsBefore = (settings: ReleaseSettings, versions: readonly VersionTag[], ref: string) => {
  const at = versions.findIndex((tag) => tag.tag === ref || tag.version === ref.replace(/^v/u, ''))
  if (at === -1) return false
  const before = timelineVersions(settings, versions).find((tag) => versions.indexOf(tag) > at)
  return before !== undefined && datedBefore(before, versions[at]!)
}

/** Whether `versions` hold the timeline page and the version before each version on it. */
const knowsPage = (
  settings: ReleaseSettings,
  versions: readonly VersionTag[],
  offset: number,
  limit: number,
) => {
  const shown = timelineVersions(settings, versions)
  if (shown.length <= offset + limit + 1) return false
  return shown
    .slice(offset, offset + limit)
    .every((tag, at) => datedBefore(shown[offset + at + 1]!, tag))
}

/** Whether `ref` reads as a version tag or version under the settings' tag format. */
const looksLikeVersion = (settings: ReleaseSettings, ref: string) =>
  versionOfTag(settings.version.tagFormat, ref) !== undefined ||
  isValidVersion(settings, ref.replace(/^v/u, ''))

const linksOf = (forge: GitForge, facts: ReleaseFacts, settings: ReleaseSettings) =>
  forgeLinks({
    kind: forge.kind === 'github' ? 'github' : 'gitlab',
    webUrl: facts.webUrl,
    ...(settings.changelog.ticketUrl ? { ticketUrl: settings.changelog.ticketUrl } : {}),
  })

const linksFor = (forge: GitForge, webUrl: string, settings: ReleaseSettings) =>
  forgeLinks({
    kind: forge.kind === 'github' ? 'github' : 'gitlab',
    webUrl,
    ...(settings.changelog.ticketUrl ? { ticketUrl: settings.changelog.ticketUrl } : {}),
  })

/** Newest outcome per environment of each tag, from the recorded deploy events. */
const deploysOf = (history: readonly ReleaseEvent[]) => {
  const byTag = new Map<string, Map<string, ReleaseVersionDeploy>>()
  const started = new Set<string>()
  for (const event of history) {
    if (!event.tag || !event.environment || !event.kind.startsWith('deploy-')) continue
    const environments = byTag.get(event.tag) ?? new Map<string, ReleaseVersionDeploy>()
    if (!environments.has(event.environment))
      environments.set(event.environment, {
        environment: event.environment,
        status:
          event.kind === 'deploy-succeeded'
            ? 'succeeded'
            : event.kind === 'deploy-failed'
              ? 'failed'
              : 'started',
        at: event.at,
        actor: event.actor,
        ...(event.actorName ? { actorName: event.actorName } : {}),
        ...(event.url ? { url: event.url } : {}),
      })
    const id = `${event.tag}\0${event.environment}`
    if (event.kind === 'deploy-started' && !started.has(id)) {
      started.add(id)
      const entry = environments.get(event.environment)!
      if (event.reason) entry.reason = event.reason
    }
    byTag.set(event.tag, environments)
  }
  return (tag: string) => [...(byTag.get(tag)?.values() ?? [])]
}

const latestDeploy = async (
  forge: GitForge,
  repo: RepoRef,
  settings: ReleaseSettings,
  facts: ReleaseFacts,
): Promise<DeployState | undefined> => {
  if (!facts.latest || settings.deploy.environments.length === 0) return undefined
  return readDeployState(forge, repo, settings, facts.latest.tag).catch(() => undefined)
}

/**
 * The release assistant on the server: reads release state from the forges with the `releases`
 * setting of each repository (only repositories that turned releases on), keeps people's edits,
 * acceptances and a history in the store's key-value part, runs steps, follows started deploys
 * until they finish, and reacts to forge events: any event of an enabled repository rereads its
 * snapshot after a short delay, new commits refresh the candidate, merges and labels accept, tags
 * drop the cached tag list. Ranges between two version tags are cached in kv for good.
 */
function createReleaseService(deps: ServerDeps) {
  const { config, store } = deps
  const kv = store.kv ?? memoryKv()
  const pollMs = deps.releasePollMs ?? 15_000
  const refreshDelayMs = deps.releaseRefreshDelayMs ?? REFRESH_DELAY_MS
  const watching = new Set<string>()
  const scheduled = new Set<string>()
  const listeners = new Set<(event: ReleaseEvent) => Promise<void> | void>()
  let refreshing: Promise<void> | undefined

  const forgeOf = (repo: RepoRef): GitForge => {
    const definition = config.forges[repo.forge]
    if (!definition) throw new Error(`forge ${repo.forge} is not configured`)
    return definition.create()
  }

  const entriesOf = (settingKey: string) => store.settings.list(settingKey)

  const settingsOf = async (repo: RepoRef): Promise<ReleaseSettings> => {
    const entry = resolveSetting(
      await entriesOf(releaseSettingsKey),
      releaseSettingsKey,
      repoTarget(config, repo),
    )
    return releaseSettings(entry?.value)
  }

  /** Whether a setting names the repository or one of its groups, not only everything. */
  const configuredFor = async (repo: RepoRef) => {
    const entry = resolveSetting(
      await entriesOf(releaseSettingsKey),
      releaseSettingsKey,
      repoTarget(config, repo),
    )
    return entry !== undefined && entry.scope.all !== true
  }

  const notifyOf = async (repo: RepoRef): Promise<ReleaseNotifySettings | undefined> => {
    const entry = resolveSetting(
      await entriesOf(releaseNotifySettingKey),
      releaseNotifySettingKey,
      repoTarget(config, repo),
    )
    if (!entry) return undefined
    try {
      const raw = entry.secret
        ? JSON.parse(await deps.vault.open(String(entry.value)))
        : entry.value
      return releaseNotifySchema.parse(raw)
    } catch (error) {
      console.error(`releases: notification setting unreadable: ${messageOf(error)}`)
      return undefined
    }
  }

  const acceptanceOf = async (repo: RepoRef) =>
    readStored(acceptanceSchema, await kv.get(key('acceptance', repo)))

  const editsOf = async (repo: RepoRef, step: Step): Promise<ReleaseEdits> =>
    readStored(releaseEditsSchema, await kv.get(key(`edits:${step}`, repo))) ?? {}

  const historyOf = async (repo: RepoRef): Promise<ReleaseEvent[]> =>
    readStored(z.array(releaseEventSchema), await kv.get(key('history', repo))) ?? []

  const record = async (event: ReleaseEvent) => {
    const history = await historyOf(event.repo)
    await kv.set(key('history', event.repo), [event, ...history].slice(0, HISTORY))
    await appendAudit(store, {
      at: event.at,
      actor: {
        id: event.actor,
        name: event.actorName ?? event.actor,
        provider: event.channel ?? 'release',
      },
      via: event.channel === 'forge' ? 'webhook' : event.channel === 'mcp' ? 'api' : 'job',
      action: `release.${event.kind}`,
      target: { type: 'release', repo: repoKeyOf(event.repo) },
      outcome: 'ok',
      details: {
        ...(event.version ? { version: event.version } : {}),
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.environment ? { environment: event.environment } : {}),
        ...(event.url ? { url: event.url } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.channel ? { channel: event.channel } : {}),
      },
    })
    const failures = await announce(await notifyOf(event.repo), event)
    for (const failure of failures) console.error(`releases: notification failed: ${failure}`)
    refreshRowLater(event.repo)
    for (const listener of listeners) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- listeners see events in order
        await listener(event)
      } catch (error) {
        console.error(`releases: event listener failed: ${messageOf(error)}`)
      }
    }
  }

  /** Calls `listener` with every recorded event; returns the unsubscribe function. */
  const subscribe = (listener: (event: ReleaseEvent) => Promise<void> | void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }

  const event = (
    kind: ReleaseEvent['kind'],
    repo: RepoRef,
    actor: ReleaseActor,
    extra: Partial<ReleaseEvent> = {},
  ): ReleaseEvent => ({
    kind,
    repo,
    actor: actor.id,
    ...(actor.name && actor.name !== actor.id ? { actorName: actor.name } : {}),
    ...(actor.channel ? { channel: actor.channel } : {}),
    at: deps.now().toISOString(),
    ...extra,
  })

  const load = async (repo: RepoRef) => {
    const settings = await settingsOf(repo)
    const forge = forgeOf(repo)
    const recorded = await acceptanceOf(repo)
    const facts = await collectFacts({
      forge,
      repo,
      settings,
      ...(recorded ? { recorded } : {}),
    })
    return { settings, forge, facts }
  }

  const planFor = async (
    repo: RepoRef,
    step: Step,
    loaded: Awaited<ReturnType<typeof load>>,
  ): Promise<ReleasePlan> =>
    planRelease({
      step,
      facts: loaded.facts,
      settings: loaded.settings,
      edits: await editsOf(repo, step),
      links: linksOf(loaded.forge, loaded.facts, loaded.settings),
      now: deps.now(),
    })

  const isReadOnly = async (repo: RepoRef) => (await deps.readOnly?.(repo)) ?? false

  const trackerOf = deps.issueTracker ?? issueTrackerFor(deps)

  /** Tracker issues of `keys`; empty without a tracker or when it fails. */
  const issuesOf = async (repo: RepoRef, keys: readonly string[]): Promise<Record<string, Issue>> =>
    keys.length === 0
      ? {}
      : issuesByKey(await trackerOf(repo).catch(() => undefined), keys, (error) =>
          console.error(
            `releases: reading issues of ${repoKeyOf(repo)} failed: ${messageOf(error)}`,
          ),
        )

  // Deploys

  const watchDeploy = (repo: RepoRef, tag: string, environment: string, actor: ReleaseActor) => {
    const id = `${repoKeyOf(repo)}@${tag}#${environment}`
    if (watching.has(id)) return
    watching.add(id)
    const work = (async () => {
      try {
        const settings = await settingsOf(repo)
        const forge = forgeOf(repo)
        const until = Date.now() + deployWatchMinutes * 60_000
        while (Date.now() < until) {
          // oxlint-disable-next-line no-await-in-loop -- polling one job until it finishes
          const state = await readDeployState(forge, repo, settings, tag).catch(() => undefined)
          const env = state?.environments.find((candidate) => candidate.name === environment)
          if (env && deployFinished(env.status)) {
            const attempt = env.attempts[0]
            const ok = env.status === 'success'
            // oxlint-disable-next-line no-await-in-loop -- the deploy finished on this poll
            await record(
              event(ok ? 'deploy-succeeded' : 'deploy-failed', repo, actor, {
                tag,
                environment,
                ...(attempt ? { url: attempt.webUrl } : {}),
                detail: ok ? 'deployed' : `deploy job ${env.status}`,
              }),
            )
            return
          }
          // oxlint-disable-next-line no-await-in-loop -- waiting between polls
          await sleep(pollMs)
        }
        await record(
          event('deploy-failed', repo, actor, {
            tag,
            environment,
            detail: `no outcome after ${deployWatchMinutes} minutes`,
          }),
        )
      } catch (error) {
        console.error(`releases: following ${id} failed: ${messageOf(error)}`)
      } finally {
        watching.delete(id)
      }
    })()
    deps.onBackground?.(work)
  }

  // Steps

  /**
   * Opens or updates the release candidate. With `writeNotes` the AI agent writes the notes
   * first (one cheap call), unless a person already wrote them.
   */
  const propose = async (
    repo: RepoRef,
    actor: ReleaseActor,
    force = false,
    writeNotes = false,
  ): Promise<ReleaseStepResult> => {
    const loaded = await load(repo)
    let plan = await planFor(repo, 'propose', loaded)
    if (writeNotes && plan.summary.source !== 'person') {
      await saveNotes(repo, 'propose', await notesFor(repo, plan), actor)
      plan = await planFor(repo, 'propose', loaded)
    }
    const result = await proposeRelease(
      {
        forge: loaded.forge,
        repo,
        settings: loaded.settings,
        now: deps.now(),
        dryRun: config.dryRun ?? false,
      },
      loaded.facts,
      plan,
      { force },
    )
    if (result.dryRun)
      return {
        kind: 'proposed',
        dryRun: true,
        detail: `would ${result.created ? 'open' : 'update'} "${plan.title}"`,
      }
    await kv.delete(key('edits:propose', repo))
    await record(
      event('proposed', repo, actor, {
        url: result.request.webUrl,
        ...(plan.version ? { version: plan.version } : {}),
        detail: `${result.created ? 'opened' : 'updated'} !${result.request.id} ${result.request.title}${force ? ' (gates overridden)' : ''}`,
      }),
    )
    return {
      kind: 'proposed',
      url: result.request.webUrl,
      detail: `${result.created ? 'Opened' : 'Updated'} !${result.request.id}`,
    }
  }

  const version = async (
    repo: RepoRef,
    actor: ReleaseActor,
    force = false,
  ): Promise<ReleaseStepResult> => {
    const loaded = await load(repo)
    const plan = await planFor(repo, 'version', loaded)
    const result = await createVersion(
      {
        forge: loaded.forge,
        repo,
        settings: loaded.settings,
        now: deps.now(),
        dryRun: config.dryRun ?? false,
      },
      loaded.facts,
      plan,
      { force },
    )
    if (result.dryRun)
      return {
        kind: 'versioned',
        dryRun: true,
        version: result.version,
        tag: result.tag,
        detail: `would tag ${result.tag}`,
      }
    await kv.delete(key('edits:version', repo))
    await kv.delete(key('acceptance', repo))
    const url =
      result.release?.webUrl ?? linksOf(loaded.forge, loaded.facts, loaded.settings).tag(result.tag)
    await record(
      event('versioned', repo, actor, {
        version: result.version,
        tag: result.tag,
        url,
        detail: `${plan.entries.filter((entry) => entry.included).length} changes${force ? ' (gates overridden)' : ''}`,
        sha: loaded.facts.target.sha,
        force,
        notes: {
          source: plan.summary.source,
          edited: edited(plan.edits),
          ...(plan.summary.markdown.trim() ? { markdown: plan.summary.markdown } : {}),
        },
        ...(result.changelogCommit ? { changelogSha: result.changelogCommit.sha } : {}),
      }),
    )
    return {
      kind: 'versioned',
      url,
      version: result.version,
      tag: result.tag,
      detail: `Created ${result.tag}`,
    }
  }

  const accept = async (
    repo: RepoRef,
    actor: ReleaseActor,
    note?: string,
    via: Acceptance['via'] = 'manual',
  ) => {
    if (!actor.id.trim()) throw new Error('an acceptance needs the person who accepts')
    const { facts } = await load(repo)
    if (facts.unreleased.length === 0)
      throw new Error('nothing on the target branch waits for a version')
    const acceptance: Acceptance = {
      sha: facts.target.sha,
      by: actor.id,
      ...(actor.name && actor.name !== actor.id ? { name: actor.name } : {}),
      at: deps.now().toISOString(),
      via,
      ...(actor.channel ? { channel: actor.channel } : {}),
      ...(note ? { note } : {}),
    }
    await kv.set(key('acceptance', repo), acceptance)
    await record(
      event('accepted', repo, actor, {
        sha: acceptance.sha,
        via,
        ...(note ? { detail: note, note } : {}),
      }),
    )
    return { kind: 'accepted' as const, detail: 'Accepted' }
  }

  const withdraw = async (repo: RepoRef) => {
    await kv.delete(key('acceptance', repo))
    refreshRowLater(repo)
  }

  const deploy = async (
    repo: RepoRef,
    input: {
      tag: string
      environment: string
      redeploy?: boolean
      force?: boolean
      reason?: string
    },
    actor: ReleaseActor,
  ): Promise<ReleaseStepResult> => {
    const settings = await settingsOf(repo)
    const forge = forgeOf(repo)
    if (config.dryRun)
      return {
        kind: 'deploy-started',
        dryRun: true,
        tag: input.tag,
        detail: `would deploy ${input.tag} to ${input.environment}`,
      }
    const { reason: given, ...start } = input
    const { job } = await startDeploy({ forge, repo, settings, ...start })
    const plain = input.force ? 'order overridden' : input.redeploy ? 'redeploy' : undefined
    const reason = given?.trim() || plain
    await record(
      event('deploy-started', repo, actor, {
        tag: input.tag,
        environment: input.environment,
        url: job.webUrl,
        jobId: job.id,
        ...(plain ? { detail: plain } : {}),
        ...(reason ? { reason } : {}),
      }),
    )
    watchDeploy(repo, input.tag, input.environment, actor)
    return {
      kind: 'deploy-started',
      url: job.webUrl,
      tag: input.tag,
      detail: `Started ${job.name}`,
    }
  }

  // Reads

  /** The board row of loaded facts: the pending step's plan with its edits, deploys with who started them. */
  const rowOf = async (
    repo: RepoRef,
    loaded: Awaited<ReturnType<typeof load>>,
    known?: { deploy?: DeployState; history?: ReleaseEvent[] },
  ) => {
    const step = pendingStep(loaded.settings, loaded.facts)
    const [deployState, history, edits] = await Promise.all([
      known ? known.deploy : latestDeploy(loaded.forge, repo, loaded.settings, loaded.facts),
      known?.history ?? historyOf(repo),
      step ? editsOf(repo, step) : undefined,
    ])
    return boardRow(loaded.settings, loaded.facts, deps.now(), {
      ...(deployState ? { deploy: withDeployActors(deployState, history) } : {}),
      ...(edits ? { edits } : {}),
    })
  }

  const row = async (repo: RepoRef): Promise<BoardRead | undefined> => {
    try {
      if (!(await settingsOf(repo)).enabled) return undefined
      const loaded = await load(repo)
      const value = await rowOf(repo, loaded)
      const head = waitingHead(value, loaded.facts)
      return { row: value, ...(head ? { head } : {}), acceptanceMode: loaded.settings.acceptance }
    } catch (error) {
      const value: ReleaseBoardRow = {
        repo,
        stage: 'idle' as const,
        mode: 'merge-request' as const,
        ahead: 0,
        aheadCapped: false,
        unreleased: 0,
        unreleasedCapped: false,
        tickets: [],
        pipelines: {},
        blockers: [],
        acceptanceRequired: false,
        reasons: [],
        leftOut: 0,
        tasks: 0,
        environments: [],
        error: messageOf(error),
      }
      return { row: value }
    }
  }

  const repositories = async (group?: string) => {
    const resolve = groupRepositories(config)
    const found = new Map<string, RepoRef>()
    for (const name of group ? [group] : rootGroups(config)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- groups one after another keep forge limits
        for (const member of await resolve(name)) found.set(repoKeyOf(member), member)
      } catch (error) {
        console.error(`releases: listing group ${name} failed: ${messageOf(error)}`)
      }
    }
    return [...found.values()]
  }

  // Overview: a snapshot in the key-value store, refreshed on forge events and every half hour

  const dismissalOf = async (repo: RepoRef) =>
    readStored(dismissalSchema, await kv.get(key('dismissal', repo)))

  const saveRow = async (repo: RepoRef, value: BoardRead | undefined) => {
    if (value) await kv.set(key('board:row', repo), { readAt: deps.now().toISOString(), ...value })
    else await kv.delete(key('board:row', repo))
    const dismissal = await dismissalOf(repo)
    if (dismissal && value?.row.error === undefined && dismissal.sha !== value?.head)
      await kv.delete(key('dismissal', repo))
    const index = readStored(boardIndexSchema, await kv.get(BOARD_INDEX))
    if (!index) return
    const listed = index.repos.some((entry) => repoKeyOf(entry) === repoKeyOf(repo))
    if (value && !listed) await kv.set(BOARD_INDEX, { ...index, repos: [...index.repos, repo] })
    if (!value && listed)
      await kv.set(BOARD_INDEX, {
        ...index,
        repos: index.repos.filter((entry) => repoKeyOf(entry) !== repoKeyOf(repo)),
      })
  }

  const storedRow = async (repo: RepoRef) =>
    readStored(storedRowSchema, await kv.get(key('board:row', repo)))

  const refreshRow = async (repo: RepoRef) => saveRow(repo, await row(repo))

  const refreshRowLater = (repo: RepoRef) => {
    const work = refreshRow(repo).catch((error: unknown) =>
      console.error(`releases: refreshing ${repoKeyOf(repo)} failed: ${messageOf(error)}`),
    )
    deps.onBackground?.(work)
  }

  /** Rereads one repository once events stop arriving for `refreshDelayMs`; bursts collapse. */
  const refreshSoon = (repo: RepoRef) => {
    const id = repoKeyOf(repo)
    if (scheduled.has(id)) return
    scheduled.add(id)
    const work = sleep(refreshDelayMs)
      .then(() => {
        scheduled.delete(id)
        return refreshRow(repo)
      })
      .catch((error: unknown) => {
        scheduled.delete(id)
        console.error(`releases: refreshing ${id} failed: ${messageOf(error)}`)
      })
    deps.onBackground?.(work)
  }

  /**
   * Rereads every repository of the config groups that turned releases on; others cost one
   * settings read and no forge call. One run at a time here.
   */
  const refreshBoard = () => {
    refreshing ??= (async () => {
      try {
        await kv.set(BOARD_REFRESHING, deps.now().toISOString(), BOARD_REFRESHING_SECONDS)
        const repos = await repositories()
        const rows = await mapLimited(repos, BOARD_CONCURRENCY, async (repo) => {
          const value = await row(repo)
          await saveRow(repo, value)
          return value
        })
        await kv.set(BOARD_INDEX, {
          repos: repos.filter((_, at) => rows[at] !== undefined),
          readAt: deps.now().toISOString(),
        })
      } catch (error) {
        console.error(`releases: refreshing the overview failed: ${messageOf(error)}`)
      } finally {
        await kv.delete(BOARD_REFRESHING).catch(() => {})
        refreshing = undefined
      }
    })()
    return refreshing
  }

  const refreshBoardLater = () => {
    const work = refreshBoard()
    deps.onBackground?.(work)
  }

  /** Refreshes the overview now when it is older than the interval, then every interval. */
  const startBoardRefresh = (intervalMs = BOARD_REFRESH_MS) => {
    void (async () => {
      const index = readStored(boardIndexSchema, await kv.get(BOARD_INDEX))
      if (!index || deps.now().getTime() - Date.parse(index.readAt) >= intervalMs)
        await refreshBoard()
    })()
    const timer = setInterval(() => void refreshBoard(), intervalMs)
    return () => clearInterval(timer)
  }

  /** One card per readable repository with releases on; `action` keeps those waiting on a person. */
  const overview = async (
    principal: Principal,
    filter: { group?: string; refresh?: boolean; action?: boolean },
  ): Promise<ReleaseOverview> => {
    let index = readStored(boardIndexSchema, await kv.get(BOARD_INDEX))
    if (!index) {
      await refreshBoard()
      index = readStored(boardIndexSchema, await kv.get(BOARD_INDEX)) ?? {
        repos: [],
        readAt: deps.now().toISOString(),
      }
    } else if (
      filter.refresh ||
      deps.now().getTime() - Date.parse(index.readAt) >= 2 * BOARD_REFRESH_MS
    ) {
      if ((await kv.get(BOARD_REFRESHING)) === undefined) refreshBoardLater()
    }
    const repos = index.repos.filter(
      (repo) => !filter.group || repoTarget(config, repo).groups.includes(filter.group),
    )
    const cards = (await cardsOf(repos, principal))
      .filter((card) => !filter.action || card.needsAction)
      .toSorted((a, b) => repoKeyOf(a.repo).localeCompare(repoKeyOf(b.repo)))
    return {
      cards,
      readAt: index.readAt,
      refreshing: refreshing !== undefined || (await kv.get(BOARD_REFRESHING)) !== undefined,
      dryRun: config.dryRun ?? false,
      people: await peopleOf(
        deps,
        cards
          .flatMap((card) => [card.acceptance?.by, card.dismissed?.by])
          .filter((id) => id !== undefined),
      ),
    }
  }

  const cardOf = (
    principal: Principal | undefined,
    stored: BoardRead,
    dismissal: Dismissal | undefined,
    readOnly: boolean,
    settings: ReleaseSettings,
  ): ReleaseCard => {
    const dismissed = dismissal && dismissal.sha === stored.head ? dismissal : undefined
    const current: ReleaseBoardRow = {
      ...stored.row,
      acceptanceRequired:
        settings.enabled &&
        !staleFor(stored, settings) &&
        settings.flow.mode !== 'external' &&
        settings.acceptance !== 'none',
    }
    return {
      ...current,
      needsAction: !dismissed && settings.enabled && needsAction(current),
      ...(stored.head ? { head: stored.head } : {}),
      can: releaseCan(config, principal, current, readOnly),
      ...(dismissed ? { dismissed } : {}),
    }
  }

  /**
   * Cards of `repos` that `principal` may read, or of all when no principal is given. Whether an
   * acceptance is required and whether a person should act follow the current `releases` setting:
   * with releases off neither holds, and a row read under another flow mode or acceptance mode
   * asks for no acceptance and is reread soon.
   */
  const cardsOf = async (repos: readonly RepoRef[], principal?: Principal) => {
    const readable = repos.filter(
      (repo) =>
        !principal ||
        can(principal, 'releases:read', { kind: 'repo', repo: repoTarget(config, repo) }),
    )
    const entries = await entriesOf(releaseSettingsKey)
    const cards = await Promise.all(
      readable.map(async (repo) => {
        const [stored, dismissal, readOnly] = await Promise.all([
          storedRow(repo),
          dismissalOf(repo),
          isReadOnly(repo),
        ])
        if (!stored) return undefined
        const settings = releaseSettings(
          resolveSetting(entries, releaseSettingsKey, repoTarget(config, repo))?.value,
        )
        if (staleFor(stored, settings)) refreshSoon(repo)
        return cardOf(principal, stored, dismissal, readOnly, settings)
      }),
    )
    return cards.filter((card) => card !== undefined)
  }

  /**
   * The stored cards as last read, never reading a forge: of those `principal` may read with its
   * `can`, or of every repository with `can` all false when no principal is given.
   */
  const snapshot = async (principal?: Principal): Promise<ReleaseCard[]> => {
    const index = readStored(boardIndexSchema, await kv.get(BOARD_INDEX))
    return index ? cardsOf(index.repos, principal) : []
  }

  /**
   * Hides the release waiting in `repo` until its head moves past `sha`; nothing changes on the
   * forge. `moved` when the stored head is not `sha` (or nothing waits).
   */
  const dismiss = async (
    repo: RepoRef,
    sha: string,
    by: string,
  ): Promise<{ kind: 'dismissed'; dismissal: Dismissal } | { kind: 'moved'; head?: string }> => {
    const stored = await storedRow(repo)
    if (!stored?.head || stored.head !== sha)
      return { kind: 'moved', ...(stored?.head ? { head: stored.head } : {}) }
    const dismissal = { sha, by, at: deps.now().toISOString() }
    await kv.set(key('dismissal', repo), dismissal)
    return { kind: 'dismissed', dismissal }
  }

  // Timeline: past versions from tags, ranges between two tags cached for good

  /**
   * Tags newest first, read in growing pages until `enough` holds for their version tags, every
   * tag is read or `TAG_MAX` is reached; the list read so far is cached for `TAGS_TTL_SECONDS`.
   */
  const tagsOf = async (
    forge: GitForge,
    repo: RepoRef,
    settings: ReleaseSettings,
    enough: (versions: readonly VersionTag[]) => boolean,
  ): Promise<StoredTags> => {
    let stored = readStored(tagsSchema, await kv.get(key('tags', repo)))
    for (;;) {
      if (!forge.listTags) return { tags: [], complete: true }
      if (
        stored &&
        (stored.complete ||
          stored.tags.length >= TAG_MAX ||
          enough(versionTags(settings, stored.tags)))
      )
        return stored
      const limit = stored ? Math.min(TAG_MAX, stored.tags.length * 2) : TAG_PAGE
      // oxlint-disable-next-line no-await-in-loop -- each page size depends on the previous read
      const read = await forge.listTags(repo.path, { limit })
      stored = {
        tags: read.map((tag) => ({
          name: tag.name,
          sha: tag.sha,
          ...(tag.committedAt ? { committedAt: tag.committedAt } : {}),
          ...(tag.createdAt ? { createdAt: tag.createdAt } : {}),
        })),
        complete: read.length < limit,
      }
      // oxlint-disable-next-line no-await-in-loop -- see above
      await kv.set(key('tags', repo), stored, TAGS_TTL_SECONDS)
    }
  }

  const versionSource = async (
    repo: RepoRef,
    enough: (settings: ReleaseSettings, versions: readonly VersionTag[]) => boolean,
  ) => {
    const settings = await settingsOf(repo)
    const forge = forgeOf(repo)
    const [repository, tags, history] = await Promise.all([
      forge.getRepository(repo.path),
      tagsOf(forge, repo, settings, (versions) => enough(settings, versions)),
      historyOf(repo),
    ])
    return {
      forge,
      repo,
      settings,
      versions: versionTags(settings, tags.tags),
      complete: tags.complete,
      cache: kv,
      links: linksFor(forge, repository.webUrl, settings),
      history,
      deploys: deploysOf(history),
    }
  }

  /**
   * One page of the version timeline, newest first. The first page also carries the next,
   * unreleased version from the overview snapshot (read now when there is none yet).
   */
  const timeline = async (
    principal: Principal | undefined,
    repo: RepoRef,
    page: { offset?: number; limit?: number } = {},
  ): Promise<ReleaseTimelineView> => {
    const offset = page.offset ?? 0
    const limit = Math.min(TIMELINE_LIMIT, Math.max(1, page.limit ?? 10))
    const source = await versionSource(repo, (settings, versions) =>
      knowsPage(settings, versions, offset, limit),
    )
    const [result, next, readOnly] = await Promise.all([
      versionTimeline({ ...source, offset, limit }),
      offset === 0 && source.settings.enabled
        ? storedRow(repo).then(async (stored) => {
            if (stored) return stored.row
            await refreshRow(repo)
            return (await storedRow(repo))?.row
          })
        : undefined,
      isReadOnly(repo),
    ])
    const versions: ReleaseVersionView[] = result.versions.map((entry) => ({
      ...entry,
      deploys: source.deploys(entry.tag),
    }))
    return {
      repo,
      enabled: source.settings.enabled,
      ...(next ? { next } : {}),
      can: next
        ? releaseCan(config, principal, next, readOnly)
        : {
            accept: false,
            run:
              !readOnly &&
              principal !== undefined &&
              can(principal, 'releases:run', { kind: 'repo', repo: repoTarget(config, repo) }),
          },
      versions,
      total: result.total,
      ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
    }
  }

  /** One version in full, with recorded deploys and the live deploy state when environments are set. */
  const versionOf = async (repo: RepoRef, tag: string) => {
    const source = await versionSource(
      repo,
      (settings, versions) =>
        !looksLikeVersion(settings, tag) || knowsBefore(settings, versions, tag),
    )
    const found = await versionDetail({ ...source, tag })
    if (!found) return undefined
    const issues = await issuesOf(
      repo,
      found.tasks.map((task) => task.key),
    )
    const detail = { ...found, tasks: withIssues(found.tasks, issues) }
    const live =
      source.settings.deploy.environments.length > 0
        ? await readDeployState(source.forge, repo, source.settings, tag).catch(() => undefined)
        : undefined
    const provenance = versionProvenance(source.history, found.tag)
    const deploys = source.deploys(found.tag)
    const people = await peopleOf(deps, [
      ...(provenance?.accepted ? [provenance.accepted.actor] : []),
      ...(provenance?.versioned ? [provenance.versioned.actor] : []),
      ...deploys.map((entry) => entry.actor),
    ])
    return {
      ...detail,
      deploys,
      ...(live ? { deploy: withDeployActors(live, source.history) } : {}),
      ...(provenance ? { provenance } : {}),
      people,
    }
  }

  /**
   * Changes between two refs: `from` and `to` name version tags (or versions) or other refs.
   * Without `to`, the target branch (the next release); without `from`, the version before `to`
   * (the latest version for the target branch). Tasks carry tracker issues when one answers and
   * the range ends at a version or the configured target or source branch, so an arbitrary branch
   * cannot pull issue titles through the repository's tracker credential.
   */
  const changes = async (
    repo: RepoRef,
    range: { from?: string; to?: string } = {},
  ): Promise<ReleaseChanges> => {
    const source = await versionSource(repo, (settings, versions) => {
      const wanted = (ref: string | undefined) =>
        ref === undefined ||
        !looksLikeVersion(settings, ref) ||
        versions.some((tag) => tag.tag === ref || tag.version === ref.replace(/^v/u, ''))
      if (!wanted(range.from)) return false
      if (range.to === undefined)
        return range.from !== undefined || timelineVersions(settings, versions).length > 0
      if (!wanted(range.to)) return false
      return (
        range.from !== undefined ||
        !looksLikeVersion(settings, range.to) ||
        knowsBefore(settings, versions, range.to)
      )
    })
    const shown = timelineVersions(source.settings, source.versions)
    const find = (ref: string) =>
      source.versions.find((tag) => tag.tag === ref || tag.version === ref.replace(/^v/u, ''))
    const target = range.to ? find(range.to) : undefined
    const branch = range.to
      ? undefined
      : (source.settings.flow.target ?? (await source.forge.getRepository(repo.path)).defaultBranch)
    const start = range.from
      ? find(range.from)
      : target
        ? shown.find(
            (tag) =>
              tag !== target && source.versions.indexOf(tag) > source.versions.indexOf(target),
          )
        : shown[0]
    const from = start?.tag ?? range.from
    const to = target?.tag ?? range.to ?? branch!
    const found = await rangeChanges({
      forge: source.forge,
      repo,
      settings: source.settings,
      ...(start
        ? { from: start.sha, current: start.version }
        : range.from
          ? { from: range.from }
          : {}),
      to: target?.sha ?? to,
      cache: kv,
      links: source.links,
    })
    const releaseRange =
      target !== undefined ||
      branch !== undefined ||
      range.to === source.settings.flow.target ||
      range.to === source.settings.flow.source
    const issues = releaseRange
      ? await issuesOf(
          repo,
          found.tasks.map((task) => task.key),
        )
      : {}
    const compareUrl = from ? source.links.compare(from, to) : undefined
    return {
      repo,
      ...found,
      tasks: withIssues(found.tasks, issues),
      ...(from ? { from } : {}),
      to,
      unreleased: branch !== undefined,
      ...(compareUrl ? { compareUrl } : {}),
    }
  }

  const view = async (principal: Principal, repo: RepoRef): Promise<ReleaseRepoView> => {
    const loaded = await load(repo)
    const { settings, facts, forge } = loaded
    const [proposal, versionPlan, liveDeploy, history, agent, readOnly] = await Promise.all([
      settings.flow.mode === 'merge-request' && facts.source && facts.ahead.length > 0
        ? planFor(repo, 'propose', loaded)
        : undefined,
      settings.flow.mode !== 'external' && facts.unreleased.length > 0
        ? planFor(repo, 'version', loaded)
        : undefined,
      latestDeploy(forge, repo, settings, facts),
      historyOf(repo),
      deps.agentFor ? deps.agentFor(repo).catch(() => undefined) : undefined,
      isReadOnly(repo),
    ])
    const target = repoTarget(config, repo)
    const deployState = liveDeploy && withDeployActors(liveDeploy, history)
    const rowValue = await rowOf(repo, loaded, {
      ...(liveDeploy ? { deploy: liveDeploy } : {}),
      history,
    })
    const links = releaseLinks(forge.kind === 'github' ? 'github' : 'gitlab', facts, deployState)
    const people = await peopleOf(deps, [
      ...history.map((entry) => entry.actor),
      ...(rowValue.acceptance ? [rowValue.acceptance.by] : []),
    ])
    const head = waitingHead(rowValue, facts)
    await saveRow(repo, settings.enabled ? { row: rowValue, ...(head ? { head } : {}) } : undefined)
    const issues = await issuesOf(repo, [
      ...new Set(
        [...(proposal?.entries ?? []), ...(versionPlan?.entries ?? [])].flatMap(
          (entry) => entry.tickets,
        ),
      ),
    ])
    return {
      repo,
      row: rowValue,
      settings,
      ...(proposal ? { proposal } : {}),
      ...(versionPlan ? { version: versionPlan } : {}),
      versions: facts.versions.slice(0, 20),
      ...(deployState ? { deploy: deployState } : {}),
      history,
      links,
      people,
      can: {
        ...releaseCan(config, principal, rowValue, readOnly),
        configure: can(principal, 'settings:write', { kind: 'repo', repo: target }),
      },
      readOnly,
      dryRun: config.dryRun ?? false,
      agent: agent !== undefined,
      ...(Object.keys(issues).length > 0 ? { issues } : {}),
    }
  }

  /**
   * The flow suggested for a repository from what it already does, read from the forge on each
   * call, and whether a setting already names the repository or one of its groups.
   */
  const detect = async (repo: RepoRef): Promise<ReleaseDetectView> => {
    const [detection, configured] = await Promise.all([
      detectRepositoryFlow(forgeOf(repo), repo),
      configuredFor(repo),
    ])
    return { repo, detection, configured }
  }

  const deployOf = async (repo: RepoRef, tag: string) =>
    readDeployState(forgeOf(repo), repo, await settingsOf(repo), tag)

  const saveEdits = async (
    repo: RepoRef,
    step: Step,
    edits: ReleaseEdits | null,
    actor: ReleaseActor,
  ) => {
    if (edits === null) await kv.delete(key(`edits:${step}`, repo))
    else
      await kv.set(key(`edits:${step}`, repo), {
        ...edits,
        updatedAt: deps.now().toISOString(),
        updatedBy: actor.id,
      })
  }

  const notesFor = async (repo: RepoRef, plan: ReleasePlan) => {
    const agent = await deps.agentFor?.(repo)
    if (!agent) throw new Error('no AI agent is configured for this repository')
    return writeSummary(agent, plan.entries, {
      ...(plan.version ? { version: plan.version } : {}),
      ...(plan.current ? { previous: plan.current.version } : {}),
    })
  }

  const saveNotes = async (repo: RepoRef, step: Step, markdown: string, actor: ReleaseActor) =>
    saveEdits(
      repo,
      step,
      {
        ...(await editsOf(repo, step)),
        summary: { markdown, source: 'agent', at: deps.now().toISOString() },
      },
      actor,
    )

  /** Has the AI agent write the notes of one step's plan, on demand; keeps them as an edit. */
  const summarize = async (repo: RepoRef, step: Step, actor: ReleaseActor) => {
    const loaded = await load(repo)
    const markdown = await notesFor(repo, await planFor(repo, step, loaded))
    await saveNotes(repo, step, markdown, actor)
    return markdown
  }

  // Forge events

  const onEvent = async (forgeEvent: ForgeEvent, source: string): Promise<void> => {
    if (forgeEvent.kind === 'note') return
    const repo = forgeEvent.repo
    const settings = await settingsOf(repo)
    if (!settings.enabled) return
    if (forgeEvent.kind === 'tag') await kv.delete(key('tags', repo))
    refreshSoon(repo)
    if (settings.flow.mode !== 'merge-request') return

    if (forgeEvent.kind === 'push') {
      if (forgeEvent.branch !== settings.flow.source) return
      if (await isReadOnly(repo)) return
      const loaded = await load(repo)
      if (!loaded.facts.request) return
      const plan = await planFor(repo, 'propose', loaded)
      await refreshProposal(
        { forge: loaded.forge, repo, settings, now: deps.now(), dryRun: config.dryRun ?? false },
        loaded.facts,
        plan,
      )
      return
    }
    if (forgeEvent.kind !== 'mergeRequest') return

    const { mr } = forgeEvent
    if (mr.sourceBranch !== settings.flow.source) return
    const target =
      settings.flow.target ?? (await forgeOf(repo).getRepository(repo.path)).defaultBranch
    if (mr.targetBranch !== target) return
    const who: ReleaseActor = { id: forgeEvent.actor || source, channel: 'forge' }
    if (forgeEvent.action === 'merge') {
      await record(event('merged', repo, who, { url: mr.webUrl, detail: `!${mr.id} ${mr.title}` }))
      if (settings.acceptance === 'merge') await accept(repo, who, `merged !${mr.id}`, 'merge')
      return
    }
    if (
      mr.state === 'merged' &&
      settings.acceptance === 'label' &&
      forgeEvent.labelsAdded.includes(acceptanceLabel)
    )
      await accept(repo, who, `label ${acceptanceLabel} on !${mr.id}`, 'label')
  }

  return {
    settingsOf,
    overview,
    snapshot,
    dismiss,
    dismissalOf,
    startBoardRefresh,
    timeline,
    versionOf,
    changes,
    view,
    detect,
    deployOf,
    saveEdits,
    summarize,
    propose,
    version,
    accept,
    withdraw,
    deploy,
    onEvent,
    isReadOnly,
    subscribe,
  }
}

export type ReleaseService = ReturnType<typeof createReleaseService>

const services = new WeakMap<ServerDeps, ReleaseService>()

/** The one release service of a server, shared by routes and the event dispatcher. */
export function releaseServiceFor(deps: ServerDeps): ReleaseService {
  let service = services.get(deps)
  if (!service) {
    service = createReleaseService(deps)
    services.set(deps, service)
  }
  return service
}
