import { can, type Principal } from '@holtkeeper/access'
import type { ReleaseBoardView, ReleaseRepoView, ReleaseStepResult } from '@holtkeeper/api'
import { forgeLinks } from '@holtkeeper/changelog'
import type { ForgeEvent, GitForge, RepoRef } from '@holtkeeper/forge'
import { groupRepositories } from '@holtkeeper/jobs'
import {
  type Acceptance,
  type DeployState,
  type ReleaseEdits,
  type ReleaseEvent,
  type ReleaseFacts,
  type ReleaseNotifySettings,
  type ReleasePlan,
  type ReleaseSettings,
  acceptanceSchema,
  announce,
  autoEnvironments,
  boardRow,
  collectFacts,
  createVersion,
  deployFinished,
  detectRepositoryFlow,
  planRelease,
  proposeRelease,
  readDeployState,
  readStored,
  refreshProposal,
  releaseEditsSchema,
  releaseEventSchema,
  releaseNotifySchema,
  releaseNotifySettingKey,
  releaseSettings,
  releaseSettingsKey,
  startDeploy,
  writeSummary,
} from '@holtkeeper/release'
import { resolveSetting } from '@holtkeeper/settings'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import { type ServerDeps, repoTarget } from './context.ts'

const HISTORY = 100
const BOARD_TTL_MS = 60_000
const BOARD_CONCURRENCY = 4

type Step = 'propose' | 'version'

const repoKeyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** In-memory stand-in for `Store.kv` on servers without one. */
function memoryKv(): Pick<KvStore, 'get' | 'set' | 'delete'> {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  }
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

const linksOf = (forge: GitForge, facts: ReleaseFacts, settings: ReleaseSettings) =>
  forgeLinks({
    kind: forge.kind === 'github' ? 'github' : 'gitlab',
    webUrl: facts.webUrl,
    ...(settings.changelog.ticketUrl ? { ticketUrl: settings.changelog.ticketUrl } : {}),
  })

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
 * setting of each repository, keeps people's edits, acceptances and a history in the store's
 * key-value part, runs steps, follows started deploys until they finish, and reacts to forge
 * events (new commits refresh the candidate, merges and labels accept, acceptance may version).
 */
function createReleaseService(deps: ServerDeps) {
  const { config, store } = deps
  const kv = store.kv ?? memoryKv()
  const pollMs = deps.releasePollMs ?? 15_000
  const watching = new Set<string>()
  let boardCache: { at: number; rows: Map<string, ReleaseBoardView['rows'][number]> } | undefined

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
    await store.activity.append({
      at: event.at,
      actor: event.actor,
      action: `release.${event.kind}`,
      subject: repoKeyOf(event.repo),
      details: {
        ...(event.version ? { version: event.version } : {}),
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.environment ? { environment: event.environment } : {}),
        ...(event.url ? { url: event.url } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
      },
    })
    const failures = await announce(await notifyOf(event.repo), event)
    for (const failure of failures) console.error(`releases: notification failed: ${failure}`)
    boardCache?.rows.delete(repoKeyOf(event.repo))
  }

  const event = (
    kind: ReleaseEvent['kind'],
    repo: RepoRef,
    actor: string,
    extra: Partial<ReleaseEvent> = {},
  ): ReleaseEvent => ({ kind, repo, actor, at: deps.now().toISOString(), ...extra })

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

  // Deploys

  const watchDeploy = (
    repo: RepoRef,
    tag: string,
    environment: string,
    actor: string,
    start: boolean,
  ) => {
    const id = `${repoKeyOf(repo)}@${tag}#${environment}`
    if (watching.has(id)) return
    watching.add(id)
    const work = (async () => {
      try {
        const settings = await settingsOf(repo)
        const forge = forgeOf(repo)
        const until = Date.now() + settings.deploy.watchMinutes * 60_000
        let started = !start
        while (Date.now() < until) {
          // oxlint-disable-next-line no-await-in-loop -- polling one job until it finishes
          const state = await readDeployState(forge, repo, settings, tag).catch(() => undefined)
          const env = state?.environments.find((candidate) => candidate.name === environment)
          if (!started && env?.status === 'ready') {
            // oxlint-disable-next-line no-await-in-loop -- the job became ready on this poll
            await startDeploy({ forge, repo, settings, tag, environment })
            started = true
            // oxlint-disable-next-line no-await-in-loop -- one record per started deploy
            await record(
              event('deploy-started', repo, actor, {
                tag,
                environment,
                detail: 'started automatically',
              }),
            )
          } else if (started && env && deployFinished(env.status)) {
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
            if (ok)
              for (const next of autoEnvironments(settings, environment))
                watchDeploy(repo, tag, next.name, actor, true)
            return
          } else if (
            !started &&
            env &&
            env.status !== 'no-pipeline' &&
            env.status !== 'missing' &&
            env.status !== 'waiting' &&
            env.status !== 'pending'
          ) {
            return
          }
          // oxlint-disable-next-line no-await-in-loop -- waiting between polls
          await sleep(pollMs)
        }
        if (started)
          await record(
            event('deploy-failed', repo, actor, {
              tag,
              environment,
              detail: `no outcome after ${settings.deploy.watchMinutes} minutes`,
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

  const propose = async (
    repo: RepoRef,
    actor: string,
    force = false,
  ): Promise<ReleaseStepResult> => {
    const loaded = await load(repo)
    const plan = await planFor(repo, 'propose', loaded)
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
    actor: string,
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
      }),
    )
    for (const environment of autoEnvironments(loaded.settings))
      watchDeploy(repo, result.tag, environment.name, actor, true)
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
    actor: string,
    note?: string,
    via: Acceptance['via'] = 'manual',
  ) => {
    const { settings, facts } = await load(repo)
    if (facts.unreleased.length === 0)
      throw new Error('nothing on the target branch waits for a version')
    const acceptance: Acceptance = {
      sha: facts.target.sha,
      by: actor,
      at: deps.now().toISOString(),
      via,
      ...(note ? { note } : {}),
    }
    await kv.set(key('acceptance', repo), acceptance)
    await record(event('accepted', repo, actor, note ? { detail: note } : {}))
    if (settings.acceptance.autoVersion) {
      try {
        const result = await version(repo, actor)
        return {
          kind: 'accepted' as const,
          detail: `Accepted; ${result.detail}`,
          ...(result.url ? { url: result.url } : {}),
        }
      } catch (error) {
        return {
          kind: 'accepted' as const,
          detail: `Accepted; the version was not created: ${messageOf(error)}`,
        }
      }
    }
    return { kind: 'accepted' as const, detail: 'Accepted' }
  }

  const withdraw = async (repo: RepoRef, actor: string) => {
    await kv.delete(key('acceptance', repo))
    await store.activity.append({
      at: deps.now().toISOString(),
      actor,
      action: 'release.acceptance_withdrawn',
      subject: repoKeyOf(repo),
    })
    boardCache?.rows.delete(repoKeyOf(repo))
  }

  const deploy = async (
    repo: RepoRef,
    input: { tag: string; environment: string; redeploy?: boolean; force?: boolean },
    actor: string,
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
    const { job } = await startDeploy({ forge, repo, settings, ...input })
    await record(
      event('deploy-started', repo, actor, {
        tag: input.tag,
        environment: input.environment,
        url: job.webUrl,
        ...(input.force
          ? { detail: 'order overridden' }
          : input.redeploy
            ? { detail: 'redeploy' }
            : {}),
      }),
    )
    watchDeploy(repo, input.tag, input.environment, actor, false)
    return {
      kind: 'deploy-started',
      url: job.webUrl,
      tag: input.tag,
      detail: `Started ${job.name}`,
    }
  }

  // Reads

  const row = async (repo: RepoRef) => {
    try {
      const loaded = await load(repo)
      if (!loaded.settings.enabled) return undefined
      const deployState = await latestDeploy(loaded.forge, repo, loaded.settings, loaded.facts)
      return boardRow(loaded.settings, loaded.facts, deps.now(), deployState)
    } catch (error) {
      return {
        repo,
        stage: 'idle' as const,
        mode: 'merge-request' as const,
        ahead: 0,
        aheadCapped: false,
        unreleased: 0,
        unreleasedCapped: false,
        tickets: [],
        pipelines: {},
        error: messageOf(error),
      }
    }
  }

  const repositories = async (group?: string) => {
    const resolve = groupRepositories(config)
    const found = new Map<string, RepoRef>()
    for (const name of group ? [group] : Object.keys(config.groups)) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- groups one after another keep forge limits
        for (const member of await resolve(name)) found.set(repoKeyOf(member), member)
      } catch (error) {
        console.error(`releases: listing group ${name} failed: ${messageOf(error)}`)
      }
    }
    return [...found.values()]
  }

  const board = async (
    principal: Principal,
    filter: { group?: string; repo?: RepoRef; refresh?: boolean },
  ): Promise<ReleaseBoardView> => {
    const now = Date.now()
    if (!boardCache || filter.refresh || now - boardCache.at > BOARD_TTL_MS)
      boardCache = { at: now, rows: new Map() }
    const cache = boardCache
    const repos = (filter.repo ? [filter.repo] : await repositories(filter.group)).filter((repo) =>
      can(principal, 'releases:read', { kind: 'repo', repo: repoTarget(config, repo) }),
    )
    const rows = await mapLimited(repos, BOARD_CONCURRENCY, async (repo) => {
      const cached = cache.rows.get(repoKeyOf(repo))
      if (cached) return cached
      const fresh = await row(repo)
      if (fresh) cache.rows.set(repoKeyOf(repo), fresh)
      return fresh
    })
    return {
      rows: rows
        .filter((entry) => entry !== undefined)
        .toSorted((a, b) => repoKeyOf(a.repo).localeCompare(repoKeyOf(b.repo))),
      readAt: new Date(cache.at).toISOString(),
      dryRun: config.dryRun ?? false,
    }
  }

  const view = async (principal: Principal, repo: RepoRef): Promise<ReleaseRepoView> => {
    const loaded = await load(repo)
    const { settings, facts, forge } = loaded
    const [proposal, versionPlan, deployState, configured, history, agent, readOnly] =
      await Promise.all([
        settings.flow.mode === 'merge-request' && facts.source && facts.ahead.length > 0
          ? planFor(repo, 'propose', loaded)
          : undefined,
        settings.flow.mode !== 'external' && facts.unreleased.length > 0
          ? planFor(repo, 'version', loaded)
          : undefined,
        latestDeploy(forge, repo, settings, facts),
        configuredFor(repo),
        historyOf(repo),
        deps.agentFor ? deps.agentFor(repo).catch(() => undefined) : undefined,
        isReadOnly(repo),
      ])
    const detection = configured
      ? undefined
      : await detectRepositoryFlow(forge, repo).catch(() => undefined)
    const target = repoTarget(config, repo)
    const rowValue = boardRow(settings, facts, deps.now(), deployState)
    boardCache?.rows.set(repoKeyOf(repo), rowValue)
    return {
      repo,
      row: rowValue,
      settings,
      ...(proposal ? { proposal } : {}),
      ...(versionPlan ? { version: versionPlan } : {}),
      versions: facts.versions.slice(0, 20),
      ...(deployState ? { deploy: deployState } : {}),
      ...(detection ? { detection } : {}),
      history,
      can: {
        run: can(principal, 'releases:run', { kind: 'repo', repo: target }),
        configure: can(principal, 'settings:write', { kind: 'repo', repo: target }),
      },
      readOnly,
      dryRun: config.dryRun ?? false,
      agent: agent !== undefined,
    }
  }

  const deployOf = async (repo: RepoRef, tag: string) =>
    readDeployState(forgeOf(repo), repo, await settingsOf(repo), tag)

  const saveEdits = async (
    repo: RepoRef,
    step: Step,
    edits: ReleaseEdits | null,
    actor: string,
  ) => {
    if (edits === null) await kv.delete(key(`edits:${step}`, repo))
    else
      await kv.set(key(`edits:${step}`, repo), {
        ...edits,
        updatedAt: deps.now().toISOString(),
        updatedBy: actor,
      })
  }

  const summarize = async (repo: RepoRef, step: Step, actor: string) => {
    const agent = await deps.agentFor?.(repo)
    if (!agent) throw new Error('no AI agent is configured for this repository')
    const loaded = await load(repo)
    const plan = await planFor(repo, step, loaded)
    const markdown = await writeSummary(agent, plan.entries, loaded.settings.summary, {
      ...(plan.version ? { version: plan.version } : {}),
      ...(plan.current ? { previous: plan.current.version } : {}),
    })
    const edits = await editsOf(repo, step)
    await saveEdits(
      repo,
      step,
      { ...edits, summary: { markdown, source: 'agent', at: deps.now().toISOString() } },
      actor,
    )
    return markdown
  }

  // Forge events

  const onEvent = async (forgeEvent: ForgeEvent, actor: string): Promise<void> => {
    if (forgeEvent.kind !== 'push' && forgeEvent.kind !== 'mergeRequest') return
    const repo = forgeEvent.repo
    const settings = await settingsOf(repo)
    if (!settings.enabled || settings.flow.mode !== 'merge-request') return
    boardCache?.rows.delete(repoKeyOf(repo))

    if (forgeEvent.kind === 'push') {
      if (forgeEvent.branch !== settings.flow.source || !settings.mergeRequest.autoUpdate) return
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

    const { mr } = forgeEvent
    if (mr.sourceBranch !== settings.flow.source) return
    const target =
      settings.flow.target ?? (await forgeOf(repo).getRepository(repo.path)).defaultBranch
    if (mr.targetBranch !== target) return
    const who = forgeEvent.actor || actor
    const signals = settings.acceptance.signals
    if (forgeEvent.action === 'merge') {
      await record(event('merged', repo, who, { url: mr.webUrl, detail: `!${mr.id} ${mr.title}` }))
      if (signals.includes('merge')) await accept(repo, who, `merged !${mr.id}`, 'merge')
      return
    }
    if (
      mr.state === 'merged' &&
      signals.includes('label') &&
      forgeEvent.labelsAdded.includes(settings.acceptance.label)
    )
      await accept(repo, who, `label ${settings.acceptance.label} on !${mr.id}`, 'label')
  }

  return {
    settingsOf,
    board,
    view,
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
