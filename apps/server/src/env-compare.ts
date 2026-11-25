import type { Principal } from '@holtkeeper/access'
import type { DependencyDiff } from '@holtkeeper/dep-diff'
import type { RepoRef } from '@holtkeeper/forge'
import { compareSchemeVersions, type EnvironmentSummary } from '@holtkeeper/release'
import { UPGRADE_CHECK_KIND, type UpgradeCheckData } from '@holtkeeper/upgrade-check'
import { webUrl } from '@holtkeeper/web-paths'

import { type ServerDeps, repoKey } from './context.ts'
import { releaseServiceFor } from './releases.ts'
import { startUpgradeCheck, upgradeCheckStatus } from './upgrade-check.ts'

/** A repository whose releases name deploy environments, as a comparison request may pick it. */
export interface EnvironmentCandidate {
  repo: RepoRef
  /** `releases.deploy.environments` names, in configured order. */
  environments: string[]
}

/** What runs on each deploy environment of one repository now. */
interface RepoEnvironments {
  repo: RepoRef
  webUrl?: string
  /** One per configured environment, in order; `tag` and `version` are absent when unknown. */
  environments: EnvironmentSummary[]
  /** Orders two versions of the repository's version scheme (negative: `a` is older). */
  compareVersions(a: string, b: string): number
}

/**
 * Where comparison requests find repositories and the versions their environments run. Reads
 * only; never touches the forge beyond what the release assistant reads.
 */
export interface EnvironmentSource {
  /** Repositories with releases on and at least one deploy environment. */
  candidates(): Promise<EnvironmentCandidate[]>
  /** The environments of `repo`, or `undefined` when its releases are off or name none. */
  read(repo: RepoRef): Promise<RepoEnvironments | undefined>
}

/** One changelog line of a comparison. */
interface ComparisonEntry {
  section: string
  text: string
  breaking: boolean
  mergeRequests: number[]
}

/** One tracker task the commits of a comparison name. */
interface ComparisonTask {
  key: string
  title?: string
  status?: string
  url?: string
}

/** One dependency whose version differs between the two versions. */
interface ComparisonDependency {
  name: string
  change: 'added' | 'removed' | 'upgraded' | 'downgraded' | 'changed'
  from?: string
  to?: string
  /** The jump crosses a major version. */
  major?: boolean
}

/** What the API (breaking-change) analysis found, when one ran for the range. */
interface ComparisonBreaking {
  status: 'done' | 'running' | 'unavailable'
  /** One line per breaking change, with migration hints when known. */
  items: string[]
}

/** The difference between two versions of one repository. */
interface EnvironmentComparison {
  repo: RepoRef
  /** The older version's tag. */
  from: string
  /** The newer version's tag. */
  to: string
  commitCount: number
  /** More commits than the range reader takes; counts are a floor. */
  capped: boolean
  entries: ComparisonEntry[]
  tasks: ComparisonTask[]
  /** Absent when no dependency diff is available for the range. */
  dependencies?: ComparisonDependency[]
  /** An AI description of the range, when the comparer writes one. */
  summary?: string
  /** Absent when the comparer has no API analysis at all. */
  breaking?: ComparisonBreaking
  /** The full report on the web compare page; absent without `server.publicUrl`. */
  reportUrl?: string
  /** The forge's compare view of the two tags. */
  compareUrl?: string
}

/**
 * Compares two versions of a repository. `from` must be the older tag; implementations never
 * write to the forge and throw only when the range cannot be read at all.
 */
export interface EnvironmentComparer {
  compare(repo: RepoRef, range: { from: string; to: string }): Promise<EnvironmentComparison>
}

/** Principal the release reads of comparisons run as: release state of every repository. */
export const comparePrincipal: Principal = {
  id: 'slack',
  name: 'Slack',
  provider: 'slack',
  grants: [{ scope: { all: true }, actions: ['repos:read', 'releases:read', 'knowledge:read'] }],
}

/** The web compare page of a range: `/releases/compare?repo=…&from=…&to=…`. */
function compareReportUrl(
  publicUrl: string | undefined,
  repo: RepoRef,
  from: string,
  to: string,
): string | undefined {
  if (!publicUrl) return undefined
  const search = new URLSearchParams({ repo: repoKey(repo), from, to })
  return webUrl(publicUrl, `/releases/compare?${search.toString()}`)
}

/**
 * The environments of repositories from the release assistant: candidates from its board
 * overview (read once when there is none yet), versions from a fresh read of the repository. An environment whose version the
 * latest deploy does not tell gets the newest version a recorded deploy reached there.
 */
export function releaseEnvironmentSource(deps: ServerDeps): EnvironmentSource {
  const releases = () => releaseServiceFor(deps)
  return {
    async candidates() {
      const { cards } = await releases().overview(comparePrincipal, {})
      return cards
        .filter((card) => card.environments.length > 0)
        .map((card) => ({
          repo: { forge: card.repo.forge, path: card.repo.path },
          environments: card.environments.map((environment) => environment.name),
        }))
    },
    async read(repo) {
      const view = await releases().view(comparePrincipal, repo)
      if (!view.settings.enabled || view.settings.deploy.environments.length === 0) return undefined
      const environments = view.row.environments.map((summary) => {
        if (summary.tag) return summary
        const reached = view.history.find(
          (event) =>
            event.kind === 'deploy-succeeded' &&
            event.environment === summary.name &&
            event.tag !== undefined,
        )
        if (!reached?.tag) return summary
        const known = view.versions.find((version) => version.tag === reached.tag)
        return {
          ...summary,
          tag: reached.tag,
          ...((known?.version ?? reached.version) && {
            version: known?.version ?? reached.version,
          }),
        }
      })
      return {
        repo,
        ...(view.row.webUrl && { webUrl: view.row.webUrl }),
        environments,
        compareVersions: (a, b) => compareSchemeVersions(view.settings, a, b),
      }
    },
  }
}

const RESULT_ENTRIES = 60
const RESULT_TASKS = 60
const RESULT_DEPENDENCIES = 40
const RESULT_BREAKING = 20
const CHECK_POLL_MS = 20_000
const CHECK_WAIT_MS = 20 * 60_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const versionOrder = (a: string, b: string) => {
  try {
    return Bun.semver.order(a.replace(/^v/u, ''), b.replace(/^v/u, ''))
  } catch {
    return 0
  }
}

const majorOf = (version: string) => /^v?(\d+)/u.exec(version)?.[1]

/** The direct dependency changes of a diff, as the summary lists them. */
function dependencyLines(diff: DependencyDiff): ComparisonDependency[] {
  const lines: ComparisonDependency[] = []
  for (const root of diff.roots)
    for (const change of root.direct) {
      const from = change.from?.version ?? change.from?.range
      const to = change.to?.version ?? change.to?.range
      const order = change.change === 'updated' && from && to ? versionOrder(from, to) : 0
      const kind =
        change.change === 'updated'
          ? order < 0
            ? 'upgraded'
            : order > 0
              ? 'downgraded'
              : 'changed'
          : change.change
      lines.push({
        name: change.name,
        change: kind,
        ...(from && { from }),
        ...(to && { to }),
        ...(from && to && majorOf(from) !== majorOf(to) && { major: true }),
      })
    }
  return lines.slice(0, RESULT_DEPENDENCIES)
}

/** Breaking and risky findings of a finished breaking-change check, one line each. */
function breakingItems(data: UpgradeCheckData | undefined): string[] {
  return (data?.findings ?? [])
    .filter((finding) => finding.severity !== 'info')
    .slice(0, RESULT_BREAKING)
    .map((finding) => `${finding.severity}: ${finding.title}. Check: ${finding.check}`)
}

/** Options of `releaseComparer`; the defaults wait up to 20 minutes for the breaking-change check. */
interface ReleaseComparerOptions {
  checkWaitMs?: number
  checkPollMs?: number
  wait?: (ms: number) => Promise<void>
}

/**
 * Compares with the release assistant's compare service: the changelog, tasks and dependency
 * changes of the range, an AI description (cheap tier, absent without an agent or when it fails)
 * and the breaking-change check (`upgrade-check`): a finished check of the same commits is
 * reused, otherwise one is queued and awaited up to `checkWaitMs`; past that `breaking` says it is
 * still running and the report page shows it when done.
 */
export function releaseComparer(
  deps: ServerDeps,
  options: ReleaseComparerOptions = {},
): EnvironmentComparer {
  const waitMs = options.checkWaitMs ?? CHECK_WAIT_MS
  const pollMs = options.checkPollMs ?? CHECK_POLL_MS
  const wait = options.wait ?? sleep
  const checkable = () =>
    !deps.analyzers || deps.analyzers.some((analyzer) => analyzer.kind === UPGRADE_CHECK_KIND)

  const breakingOf = async (
    repo: RepoRef,
    range: { from: string; to: string },
  ): Promise<ComparisonBreaking | undefined> => {
    if (!checkable() || !(await deps.agentFor?.(repo).catch(() => undefined))) return undefined
    const releases = releaseServiceFor(deps)
    const ends = await releases.compareRange(repo, range)
    const status = () => upgradeCheckStatus(deps.store, repo, ends.from.sha, ends.to.sha)
    let current = await status()
    if (current.status === 'none' || (current.status === 'failed' && !current.data)) {
      await startUpgradeCheck(deps, { ...ends, repo, actor: comparePrincipal.id })
      current = await status()
    }
    for (
      let waited = 0;
      (current.status === 'queued' || current.status === 'running') && waited < waitMs;
      waited += pollMs
    ) {
      // oxlint-disable-next-line no-await-in-loop -- polling the queued check
      await wait(pollMs)
      // oxlint-disable-next-line no-await-in-loop -- polling the queued check
      current = await status()
    }
    if (current.status === 'queued' || current.status === 'running')
      return { status: 'running', items: [] }
    if (current.data) return { status: 'done', items: breakingItems(current.data) }
    return { status: 'unavailable', items: [] }
  }

  return {
    async compare(repo, range) {
      const releases = releaseServiceFor(deps)
      const [found, summary, breaking] = await Promise.all([
        releases.changesWithDependencies(repo, range),
        releases
          .compareSummary(repo, range)
          .then((answer) => answer.markdown)
          .catch(() => undefined),
        breakingOf(repo, range).catch((): ComparisonBreaking => ({
          status: 'unavailable',
          items: [],
        })),
      ])
      const reportUrl = compareReportUrl(deps.config.server?.publicUrl, repo, range.from, range.to)
      return {
        repo,
        from: range.from,
        to: range.to,
        commitCount: found.commitCount,
        capped: found.capped,
        entries: found.entries
          .filter((entry) => entry.included)
          .slice(0, RESULT_ENTRIES)
          .map((entry) => ({
            section: entry.section,
            text: entry.text,
            breaking: entry.breaking,
            mergeRequests: entry.mergeRequests,
          })),
        tasks: found.tasks.slice(0, RESULT_TASKS).map((task) => ({
          key: task.key,
          ...((task.issue?.title ?? task.titles[0]) && {
            title: task.issue?.title ?? task.titles[0],
          }),
          ...(task.issue?.status && { status: task.issue.status }),
          ...((task.issue?.url ?? task.url) && { url: task.issue?.url ?? task.url }),
        })),
        ...(found.dependencies && { dependencies: dependencyLines(found.dependencies) }),
        ...(summary && { summary }),
        ...(breaking && { breaking }),
        ...(reportUrl && { reportUrl }),
        ...(found.compareUrl && { compareUrl: found.compareUrl }),
      }
    },
  }
}
