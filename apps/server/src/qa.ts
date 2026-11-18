import type { Principal } from '@holtkeeper/access'
import { ToolError } from '@holtkeeper/agent-tools'
import type {
  QaChangeView,
  QaSummaryView,
  QaTaskList,
  QaTaskRow,
  QaTaskView,
} from '@holtkeeper/api'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import { type Issue, issuesByKey } from '@holtkeeper/issues'
import {
  type QaChange,
  type QaChangeDetail,
  type QaRepoHistory,
  type QaSettings,
  type QaSummaryChange,
  type QaTask,
  catchAllMatcher,
  changeDetail,
  changeDiff,
  changesOf,
  diffExcerpt,
  groupTasks,
  qaChangeDetailSchema,
  qaRepoHistorySchema,
  qaSettingKey,
  qaSettings,
  qaSummarySectionsSchema,
  readRepoHistory,
  staleness,
  summarizeTask,
  summaryInputs,
} from '@holtkeeper/qa'
import { readStored, releaseSettings, releaseSettingsKey } from '@holtkeeper/release'
import { testIdOverridesFor, testIdsSettingKey } from '@holtkeeper/rules'
import { resolveSetting } from '@holtkeeper/settings'
import type { KvStore } from '@holtkeeper/store'
import { defaultAttributes } from '@holtkeeper/testids'
import { z } from 'zod'

import { type ServerDeps, repoKey, repoTarget } from './context.ts'
import { issueTrackerFor } from './issues.ts'
import type { QaToolsAccess } from './tools/qa.ts'
import { listedRepos } from './updates.ts'
import { canSee } from './visibility.ts'

/** Setting whose `language` AI texts default to across the product. */
const REVIEW_SETTING_KEY = 'analyzers.review'
const reviewLanguageSchema = z.object({ language: z.string().trim().min(1) })

/** The longest period the list offers; histories are read for it. */
const QA_MAX_DAYS = 90
/** Periods `GET /api/qa/tasks` accepts. */
export const qaPeriods = [7, 30, 90] as const

const DAY_MS = 24 * 60 * 60_000
/** A repository read this recently is not read again. */
const FRESH_MS = 5 * 60_000
/** After a failed read the repository waits this long before the next attempt. */
const FAILED_SECONDS = 10 * 60
/** Histories of repositories nobody looks at expire. */
const HISTORY_SECONDS = 30 * 24 * 60 * 60
const DETAIL_SECONDS = 30 * 24 * 60 * 60
const READ_CONCURRENCY = 4
const DETAIL_CONCURRENCY = 4
/** Changes of one task whose files are read for its page. */
const DETAIL_CAP = 40
/** Changes of one task the agent reads, newest first. */
const SUMMARY_CHANGE_CAP = 30
/** Summaries kept per task, newest first. */
const SUMMARY_VERSIONS = 5

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const historyKey = (repo: RepoRef) => `qa:history:${repoKey(repo)}`
const failedKey = (repo: RepoRef) => `qa:failed:${repoKey(repo)}`
const summaryKey = (key: string) => `qa:summary:${key}`
const detailKey = (change: QaChange) =>
  change.kind === 'open-merge-request'
    ? `qa:detail:${repoKey(change.repo)}${change.id}#${change.head}`
    : `qa:detail:${repoKey(change.repo)}:${change.base ?? ''}..${change.head}`

const storedSummarySchema = z.object({
  sections: qaSummarySectionsSchema,
  at: z.string(),
  by: z.object({ id: z.string(), name: z.string() }),
  model: z.string().optional(),
  costUsd: z.number().optional(),
  repos: z.array(z.string()),
  inputs: z.array(z.string()),
})
type StoredSummary = z.infer<typeof storedSummarySchema>

/** In-memory stand-in for `Store.kv` on servers without one; expiry is ignored. */
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

/** The view of a stored summary, stale against the current `changes` of its task. */
const summaryView = (summary: StoredSummary, changes: readonly QaChange[]): QaSummaryView => {
  const stale = staleness(summary.inputs, changes)
  return {
    sections: summary.sections,
    at: summary.at,
    by: summary.by,
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.costUsd === undefined ? {} : { costUsd: summary.costUsd }),
    repos: summary.repos,
    changes: summary.inputs.length,
    ...(stale ? { stale } : {}),
  }
}

/** A task the caller asked for that has no changes in readable repositories. */
export class QaTaskNotFoundError extends Error {}

/** A summary was asked for that cannot be written; the message says why. */
export class QaSummaryError extends Error {}

/** The QA service of a server; see `qaServiceFor`. */
export interface QaService {
  /** Tasks with changes in the last `days` in repositories `principal` may read releases of. */
  tasks(principal: Principal, options: { days: number; team?: string }): Promise<QaTaskList>
  /** One task with the files of its changes and the newest summary `principal` may read. */
  task(principal: Principal, key: string): Promise<QaTaskView>
  /**
   * Writes a new summary of a task from the changes `principal` may read; rejects with
   * `QaTaskNotFoundError` or `QaSummaryError` (no agent, already being written).
   */
  summarize(principal: Principal, key: string): Promise<QaSummaryView>
  /** The repository whose agent writes the summary of `key`: the one of its newest change. */
  summaryRepo(principal: Principal, key: string): Promise<RepoRef | undefined>
}

function createQaService(deps: ServerDeps): QaService {
  const { config, store } = deps
  const kv = store.kv ?? memoryKv()
  const reading = new Set<string>()
  const summarizing = new Set<string>()
  const trackerOf = deps.issueTracker ?? issueTrackerFor(deps)

  const forgeOf = (repo: RepoRef): GitForge => {
    const definition = config.forges[repo.forge]
    if (!definition) throw new Error(`forge ${repo.forge} is not configured`)
    return definition.create()
  }

  const settingsOf = async (repo: RepoRef): Promise<QaSettings> =>
    qaSettings(
      resolveSetting(
        await store.settings.list(qaSettingKey),
        qaSettingKey,
        repoTarget(config, repo),
      )?.value,
    )

  /** The language of test notes for `repo`: the `qa` setting's, else the review language, else English. */
  const languageOf = async (repo: RepoRef) => {
    const own = (await settingsOf(repo)).language
    if (own) return own
    const review = resolveSetting(
      await store.settings.list(REVIEW_SETTING_KEY),
      REVIEW_SETTING_KEY,
      repoTarget(config, repo),
    )?.value
    return reviewLanguageSchema.safeParse(review).data?.language ?? 'English'
  }

  /** The `qa` settings of every repository, read with one settings query. */
  const settingsFor = async (repos: readonly RepoRef[]) => {
    const entries = await store.settings.list(qaSettingKey)
    return new Map(
      repos.map((repo) => [
        repoKey(repo),
        qaSettings(resolveSetting(entries, qaSettingKey, repoTarget(config, repo))?.value),
      ]),
    )
  }

  /**
   * Branches whose changes count: the setting's, else the release flow's (work branch first, then
   * the branch versions are tagged on), else the default branch.
   */
  const branchesOf = async (repo: RepoRef, settings: QaSettings, defaultBranch: string) => {
    if (settings.branches?.length) return settings.branches
    const release = releaseSettings(
      resolveSetting(
        await store.settings.list(releaseSettingsKey),
        releaseSettingsKey,
        repoTarget(config, repo),
      )?.value,
    )
    if (!release.enabled || release.flow.mode === 'external') return [defaultBranch]
    const target = release.flow.target ?? defaultBranch
    return release.flow.mode === 'merge-request' ? [release.flow.source, target] : [target]
  }

  const historyOf = async (repo: RepoRef) =>
    readStored(qaRepoHistorySchema, await kv.get(historyKey(repo)))

  const readRepo = async (repo: RepoRef) => {
    const settings = await settingsOf(repo)
    const forge = forgeOf(repo)
    const previous = await historyOf(repo)
    const defaultBranch = (await forge.getRepository(repo.path)).defaultBranch
    const now = deps.now()
    const history = await readRepoHistory({
      forge,
      repo,
      defaultBranch,
      branches: await branchesOf(repo, settings, defaultBranch),
      since: new Date(now.getTime() - QA_MAX_DAYS * DAY_MS).toISOString(),
      now,
      ...(previous ? { previous } : {}),
    })
    await kv.set(historyKey(repo), history, HISTORY_SECONDS)
    await kv.delete(failedKey(repo))
  }

  /** Starts reading `repos` in the background, skipping those being read already. */
  const refresh = (repos: readonly RepoRef[]) => {
    const todo = repos.filter((repo) => !reading.has(repoKey(repo)))
    if (todo.length === 0) return
    for (const repo of todo) reading.add(repoKey(repo))
    const work = mapLimited(todo, READ_CONCURRENCY, async (repo) => {
      try {
        await readRepo(repo)
      } catch (error) {
        console.error(`qa: reading ${repoKey(repo)} failed: ${messageOf(error)}`)
        await kv.set(failedKey(repo), messageOf(error), FAILED_SECONDS).catch(() => {})
      } finally {
        reading.delete(repoKey(repo))
      }
    }).then(() => undefined)
    deps.onBackground?.(work)
  }

  interface RepoState {
    repo: RepoRef
    settings: QaSettings
    history?: QaRepoHistory
    failed?: string
  }

  /**
   * Repositories with the `qa` setting on that `principal` may read releases of, with their stored
   * histories; starts reading those never read or read too long ago (unless their last read failed
   * recently).
   */
  const statesOf = async (principal: Principal, team?: string): Promise<RepoState[]> => {
    const listed = (await listedRepos(store.kv, config)).filter((repo) => {
      const target = repoTarget(config, repo)
      return canSee(principal, 'releases:read', target) && (!team || target.teams.includes(team))
    })
    const settings = await settingsFor(listed)
    const enabled = listed.filter((repo) => settings.get(repoKey(repo))?.enabled !== false)
    const states = await Promise.all(
      enabled.map(async (repo): Promise<RepoState> => {
        const [history, failed] = await Promise.all([
          historyOf(repo),
          kv.get(failedKey(repo)).then((value) => (typeof value === 'string' ? value : undefined)),
        ])
        return {
          repo,
          settings: settings.get(repoKey(repo))!,
          ...(history ? { history } : {}),
          ...(failed ? { failed } : {}),
        }
      }),
    )
    const now = deps.now().getTime()
    refresh(
      states
        .filter(
          (state) =>
            !state.failed && (!state.history || now - Date.parse(state.history.readAt) >= FRESH_MS),
        )
        .map((state) => state.repo),
    )
    return states
  }

  const changesIn = (states: readonly RepoState[], since: string) =>
    states.flatMap((state) =>
      state.history ? changesOf(state.history).filter((change) => change.at >= since) : [],
    )

  /** Whether a key is a placeholder under the `qa` setting of the change's repository. */
  const catchAllOf = (states: readonly RepoState[]) => {
    const matchers = new Map(
      states.map((state) => [repoKey(state.repo), catchAllMatcher(state.settings.catchAllKeys)]),
    )
    return (key: string, repo: RepoRef) => matchers.get(repoKey(repo))?.(key) ?? false
  }

  /** Every task of the readable histories over `QA_MAX_DAYS`, placeholders left out. */
  const tasksOf = (states: readonly RepoState[]) =>
    groupTasks(
      changesIn(states, new Date(deps.now().getTime() - QA_MAX_DAYS * DAY_MS).toISOString()),
      { isCatchAll: catchAllOf(states) },
    )

  /** Tracker issues of `tasks`, asked of the tracker of each task's newest repository. */
  const issuesOf = async (tasks: readonly QaTask[]): Promise<Record<string, Issue>> => {
    const byRepo = new Map<string, { repo: RepoRef; keys: string[] }>()
    for (const task of tasks) {
      const repo = task.repos[0]
      if (!repo) continue
      const group = byRepo.get(repoKey(repo)) ?? { repo, keys: [] }
      group.keys.push(task.key)
      byRepo.set(repoKey(repo), group)
    }
    const found = await Promise.all(
      [...byRepo.values()].map(async ({ repo, keys }) =>
        issuesByKey(await trackerOf(repo).catch(() => undefined), keys, (error) =>
          console.error(`qa: reading issues of ${repoKey(repo)} failed: ${messageOf(error)}`),
        ),
      ),
    )
    return Object.fromEntries(found.flatMap((issues) => Object.entries(issues)))
  }

  /** The issue's page, else the release flow's `changelog.ticketUrl` of the task's repository. */
  const urlOf = async (key: string, repo: RepoRef | undefined, issue: Issue | undefined) => {
    if (issue?.url) return issue.url
    if (!repo) return undefined
    const template = releaseSettings(
      resolveSetting(
        await store.settings.list(releaseSettingsKey),
        releaseSettingsKey,
        repoTarget(config, repo),
      )?.value,
    ).changelog.ticketUrl
    return template?.replaceAll('{id}', encodeURIComponent(key))
  }

  const summariesOf = async (key: string): Promise<StoredSummary[]> =>
    readStored(z.array(storedSummarySchema), await kv.get(summaryKey(key))) ?? []

  /** The newest summary whose repositories `principal` may all read. */
  const visibleSummary = (principal: Principal, summaries: readonly StoredSummary[]) =>
    summaries.find((summary) =>
      summary.repos.every((id) => {
        const separator = id.indexOf(':')
        const repo = { forge: id.slice(0, separator), path: id.slice(separator + 1) }
        return canSee(principal, 'releases:read', repoTarget(config, repo))
      }),
    )

  const tasks: QaService['tasks'] = async (principal, { days, team }) => {
    const states = await statesOf(principal, team)
    const since = new Date(deps.now().getTime() - days * DAY_MS).toISOString()
    const grouped = tasksOf(states)
    const inPeriod = grouped.tasks
      .map((task) => ({ task, recent: task.changes.filter((change) => change.at >= since) }))
      .filter((item) => item.recent.length > 0)
    const issues = await issuesOf(inPeriod.map((item) => item.task))
    const isCatchAll = catchAllOf(states)
    const untracked = changesIn(states, since).filter((change) =>
      change.keys.every((key) => isCatchAll(key, change.repo)),
    ).length
    const rows = await Promise.all(
      inPeriod.map(async ({ task, recent }): Promise<QaTaskRow> => {
        const issue = issues[task.key]
        const url = await urlOf(task.key, task.repos[0], issue)
        const summary = visibleSummary(principal, await summariesOf(task.key))
        const repos = new Map(recent.map((change) => [repoKey(change.repo), change.repo]))
        return {
          key: task.key,
          title: issue?.title || task.title,
          ...(issue ? { issue } : {}),
          ...(url ? { url } : {}),
          repos: [...repos.values()],
          teams: [
            ...new Set([...repos.values()].flatMap((repo) => repoTarget(config, repo).teams)),
          ].toSorted(),
          lastAt: task.lastAt,
          counts: {
            merged: recent.filter((change) => change.kind === 'merge-request').length,
            open: recent.filter((change) => change.kind === 'open-merge-request').length,
            direct: recent.filter((change) => change.kind === 'commit' || change.kind === 'merge')
              .length,
          },
          authors: [...new Set(recent.flatMap((change) => change.authors))],
          ...(summary
            ? { summary: staleness(summary.inputs, task.changes) ? 'stale' : 'fresh' }
            : {}),
        }
      }),
    )
    const read = states.filter((state) => state.history)
    const oldest = read.map((state) => state.history!.readAt).toSorted()[0]
    return {
      tasks: rows,
      days,
      untracked,
      repos: {
        listed: states.length,
        read: read.length,
        pending: states.filter((state) => !state.history && !state.failed).length,
        failed: states.filter((state) => state.failed).map((state) => repoKey(state.repo)),
      },
      ...(oldest ? { readAt: oldest } : {}),
    }
  }

  /** The task `key` over the readable histories, or `undefined` when nothing names it. */
  const findTask = async (principal: Principal, key: string) => {
    const states = await statesOf(principal)
    const task = tasksOf(states).tasks.find((item) => item.key === key)
    return { task, states }
  }

  const attributesOf = async (repos: readonly RepoRef[]) => {
    const entries = await store.settings.list(testIdsSettingKey)
    return new Map(
      repos.map((repo) => [
        repoKey(repo),
        testIdOverridesFor(entries, repoTarget(config, repo)).attributes ?? defaultAttributes,
      ]),
    )
  }

  /** The detail of a change from the store, else read from the forge and stored. */
  const detailOf = async (
    change: QaChange,
    attributes: readonly string[],
  ): Promise<QaChangeDetail> => {
    const stored = readStored(qaChangeDetailSchema, await kv.get(detailKey(change)))
    if (stored) return stored
    const detail = changeDetail(await changeDiff(forgeOf(change.repo), change), attributes)
    await kv.set(detailKey(change), detail, DETAIL_SECONDS)
    return detail
  }

  const agentHint = async (repo: RepoRef | undefined) => {
    if (!repo) return 'the task has no changes'
    const agent = await deps.agentFor?.(repo).catch(() => undefined)
    return agent ? undefined : 'no AI agent is configured for this repository'
  }

  const task: QaService['task'] = async (principal, key) => {
    const { task: found, states } = await findTask(principal, key)
    if (!found) throw new QaTaskNotFoundError(`no changes name ${key}`)
    const [issues, attributes, summaries] = await Promise.all([
      issuesOf([found]),
      attributesOf(found.repos),
      summariesOf(key),
    ])
    const issue = issues[key]
    const changes = await mapLimited(
      found.changes.map((change, index) => ({ change, index })),
      DETAIL_CONCURRENCY,
      async ({ change, index }): Promise<QaChangeView> => {
        if (index >= DETAIL_CAP)
          return { ...change, detailError: 'too many changes: files are read for the newest only' }
        try {
          return {
            ...change,
            detail: await detailOf(change, attributes.get(repoKey(change.repo)) ?? []),
          }
        } catch (error) {
          return { ...change, detailError: messageOf(error) }
        }
      },
    )
    const summary = visibleSummary(principal, summaries)
    const newest = found.repos[0]
    const allowed =
      newest !== undefined && canSee(principal, 'analyses:run', repoTarget(config, newest))
    const hint = allowed
      ? await agentHint(newest)
      : 'needs the right to run analyses in the repository of the newest change'
    const url = await urlOf(key, newest, issue)
    return {
      key,
      title: issue?.title || found.title,
      ...(issue ? { issue } : {}),
      ...(url ? { url } : {}),
      changes,
      repos: found.repos,
      ...(summary ? { summary: summaryView(summary, found.changes) } : {}),
      pending: states.filter((state) => !state.history && !state.failed).length,
      can: { summarize: hint === undefined },
      ...(hint ? { summarizeHint: hint } : {}),
    }
  }

  const summaryRepo: QaService['summaryRepo'] = async (principal, key) =>
    (await findTask(principal, key)).task?.repos[0]

  const summarize: QaService['summarize'] = async (principal, key) => {
    if (summarizing.has(key)) throw new QaSummaryError(`a summary of ${key} is being written`)
    summarizing.add(key)
    try {
      const { task: found } = await findTask(principal, key)
      if (!found) throw new QaTaskNotFoundError(`no changes name ${key}`)
      const repo = found.repos[0]!
      const agent = await deps.agentFor?.(repo)
      if (!agent) throw new QaSummaryError('no AI agent is configured for this repository')
      const [issues, attributes, language] = await Promise.all([
        issuesOf([found]),
        attributesOf(found.repos),
        languageOf(repo),
      ])
      const issue = issues[key]
      const inputs = await mapLimited(
        found.changes.map((change, index) => ({ change, index })),
        DETAIL_CONCURRENCY,
        async ({ change, index }): Promise<QaSummaryChange> => {
          // Older changes beyond the cap reach the agent by their titles only.
          if (index >= SUMMARY_CHANGE_CAP) return { change }
          try {
            const files = await changeDiff(forgeOf(change.repo), change)
            const detail = changeDetail(files, attributes.get(repoKey(change.repo)) ?? [])
            await kv.set(detailKey(change), detail, DETAIL_SECONDS)
            return { change, detail, excerpt: diffExcerpt(files, { budget: 20_000 }) }
          } catch {
            return { change }
          }
        },
      )
      const result = await summarizeTask(agent, {
        key,
        title: issue?.title || found.title,
        ...(issue ? { issue } : {}),
        changes: inputs,
        language,
      })
      const stored: StoredSummary = {
        sections: result.sections,
        at: deps.now().toISOString(),
        by: { id: principal.id, name: principal.name },
        ...(result.model ? { model: result.model } : {}),
        ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
        repos: [...new Set(found.changes.map((change) => repoKey(change.repo)))],
        inputs: summaryInputs(found.changes),
      }
      await kv.set(
        summaryKey(key),
        [stored, ...(await summariesOf(key))].slice(0, SUMMARY_VERSIONS),
      )
      return summaryView(stored, found.changes)
    } finally {
      summarizing.delete(key)
    }
  }

  return { tasks, task, summarize, summaryRepo }
}

const services = new WeakMap<ServerDeps, QaService>()

/**
 * The QA service of a server, one per `deps`: tasks (ticket keys) with the changes that name
 * them, read on demand from the branches of every repository with the `qa` setting on. Histories
 * are read in the background, incrementally, and kept in the store's key-value part; the files of
 * a change are read when its task is opened and kept by their commit range. Summaries are written
 * by the AI agent only when a person asks and are kept with the changes they were written from,
 * so a later change marks them stale. Nothing is written to a forge.
 */
export function qaServiceFor(deps: ServerDeps): QaService {
  let service = services.get(deps)
  if (!service) {
    service = createQaService(deps)
    services.set(deps, service)
  }
  return service
}

/**
 * The `qa` MCP toolset's access for `principal`: the same lists and tasks the HTTP routes answer
 * them, with unknown teams and keys as `ToolError`s. It never writes summaries.
 */
export function qaToolsAccess(deps: ServerDeps, principal: Principal): QaToolsAccess {
  const qa = qaServiceFor(deps)
  return {
    tasks: ({ days, team }) => {
      if (team && !deps.config.teams[team]) throw new ToolError(`Unknown team ${team}.`)
      return qa.tasks(principal, { days, ...(team ? { team } : {}) })
    },
    task: (key) =>
      qa.task(principal, key).catch((error: unknown) => {
        if (error instanceof QaTaskNotFoundError)
          throw new ToolError(
            `No change in the last 90 days of repositories you can read names ${key}; check the key or call qa_tasks.`,
          )
        throw error
      }),
  }
}
