import type {
  StackConventionResult,
  StackCycle,
  StackGroupView,
  StackTool,
  StackUse,
} from '@holtkeeper/api'
import { changeDiff } from '@holtkeeper/changes'
import { type DirectDependency, directDependencies, latestDepgraphs } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import { assessUsage, type StackData, stackDataSchema } from '@holtkeeper/stack'
import type { AnalysisRecord, AnalysisStore } from '@holtkeeper/store'

const WEEK = 7 * 86_400_000

/** What a stack view may show of a repository. */
export interface StackAccess {
  /** Repositories whose stack facts (tools, versions, convention status) are listed. */
  canRead: (repo: RepoRef) => boolean
  /** Repositories whose convention diffs and fixes are shown too; default `canRead`. */
  canFix?: (repo: RepoRef) => boolean
  /**
   * Repositories whose convention problems and read errors are shown as written; others get a
   * count only, since problems quote values from the files. Default `canFix`, then `canRead`.
   */
  canDetail?: (repo: RepoRef) => boolean
  /** The config groups of a repository. */
  groupsOf: (repo: RepoRef) => string[]
}

/** A group's stack view without the week-over-week comparison. */
type StackGroupBase = Omit<StackGroupView, 'changes'>

const ending = (use: StackUse) => use.support === 'eol' || use.support === 'eol-soon'
const failing = (result: StackConventionResult) =>
  result.status === 'drifts' || result.status === 'missing'

function stackTools(data: StackData, keep: (repo: string) => boolean): StackTool[] {
  const at = new Date(data.checkedAt)
  return data.components.flatMap((component): StackTool[] => {
    const uses = component.usages
      .filter((usage) => keep(usage.repo))
      .map((usage): StackUse => {
        const status = assessUsage(component, usage, at, data.soonDays)
        return {
          repo: usage.repo,
          file: usage.file,
          via: usage.via,
          declared: usage.declared,
          ...(usage.version ? { version: usage.version } : {}),
          ...(usage.variant ? { variant: usage.variant } : {}),
          ...(usage.image ? { image: usage.image } : {}),
          lag: status.lag,
          support: status.support,
          ...(status.cycle ? { cycle: status.cycle.cycle } : {}),
          ...(status.eolDate ? { eolDate: status.eolDate } : {}),
        }
      })
    if (!uses.length) return []
    return [
      {
        id: component.id,
        name: component.name,
        kind: component.kind,
        ...(component.latest ? { latest: component.latest } : {}),
        ...(component.latestLts ? { latestLts: component.latestLts } : {}),
        ...(component.cycles?.length
          ? {
              cycles: component.cycles.map((cycle): StackCycle => ({
                cycle: cycle.cycle,
                ...(cycle.releaseDate ? { releaseDate: cycle.releaseDate } : {}),
                eol: cycle.eol,
                ...(cycle.lts !== undefined ? { lts: cycle.lts } : {}),
                ...(cycle.latest ? { latest: cycle.latest } : {}),
              })),
            }
          : {}),
        uses,
      },
    ]
  })
}

const problemCount = (problems: string[]) =>
  problems.length
    ? [
        `${problems.length} difference${problems.length === 1 ? '' : 's'}; details are visible to the owning team`,
      ]
    : []

function stackConventions(
  data: StackData,
  keep: (repo: string) => boolean,
  fixable: (repo: string) => boolean,
  detailed: (repo: string) => boolean,
): StackConventionResult[] {
  return data.conventions
    .filter((result) => keep(result.repo))
    .map((result) => ({
      repo: result.repo,
      file: result.file,
      mode: result.mode,
      status: result.status,
      problems: detailed(result.repo) ? result.problems : problemCount(result.problems),
      ...(result.change && fixable(result.repo)
        ? { changeId: result.change.id, diff: changeDiff(result.change) }
        : {}),
    }))
}

/**
 * One group's stack record as `access` lets it be seen: tools and uses judged at the record's
 * `checkedAt`, convention results with diffs only for `canFix` repositories. `undefined` when no
 * repository of the record is readable.
 */
function stackGroupView(
  record: AnalysisRecord,
  data: StackData,
  access: StackAccess,
): StackGroupBase | undefined {
  const forge = record.repo.forge
  const groupsOf = (path: string) => access.groupsOf({ forge, path })
  const readable = new Set(
    data.repos.map((repo) => repo.path).filter((path) => access.canRead({ forge, path })),
  )
  if (!readable.size) return undefined
  const keep = (repo: string) => readable.has(repo)
  const canFix = access.canFix ?? access.canRead
  const canDetail = access.canDetail ?? canFix
  const detailed = (path: string) => canDetail({ forge, path })
  return {
    forge,
    group: data.group || record.repo.path,
    analysisId: record.id,
    createdAt: record.createdAt,
    checkedAt: data.checkedAt,
    soonDays: data.soonDays,
    repos: data.repos
      .filter((repo) => keep(repo.path))
      .map((repo) => ({
        path: repo.path,
        groups: groupsOf(repo.path),
        ...(repo.webUrl ? { webUrl: repo.webUrl } : {}),
        ...(repo.error
          ? { error: detailed(repo.path) ? repo.error : 'The repository could not be read.' }
          : {}),
        ...(repo.archived ? { archived: true } : {}),
      })),
    tools: stackTools(data, keep),
    conventions: stackConventions(data, keep, (path) => canFix({ forge, path }), detailed),
  }
}

const endingLines = (view: Pick<StackGroupView, 'tools'>) =>
  new Set(
    view.tools.flatMap((tool) =>
      tool.uses.filter(ending).map((use) => `${use.repo}\0${tool.id}\0${use.cycle ?? ''}`),
    ),
  )
const driftKeys = (view: Pick<StackGroupView, 'conventions'>) =>
  new Set(view.conventions.filter(failing).map((result) => `${result.repo}\0${result.file}`))
const countMissing = (from: Set<string>, without: Set<string>) =>
  [...from].filter((key) => !without.has(key)).length

function stackChanges(
  current: Pick<StackGroupView, 'tools' | 'conventions'>,
  previous: Pick<StackGroupView, 'tools' | 'conventions'>,
) {
  const [eolNow, eolBefore] = [endingLines(current), endingLines(previous)]
  const [driftNow, driftBefore] = [driftKeys(current), driftKeys(previous)]
  return {
    newEol: countMissing(eolNow, eolBefore),
    resolvedEol: countMissing(eolBefore, eolNow),
    newDrifts: countMissing(driftNow, driftBefore),
    resolvedDrifts: countMissing(driftBefore, driftNow),
  }
}

/**
 * The newest `stack` record of every config group with a repository `access` allows, sorted by
 * group. With `compare`, each view also says what changed since the group's record from a week
 * earlier. Reads stored records only.
 */
export async function stackGroupViews(
  analyses: Pick<AnalysisStore, 'latest' | 'list'>,
  access: StackAccess,
  options: { compare?: boolean } = {},
): Promise<StackGroupView[]> {
  const groups: StackGroupView[] = []
  for (const record of await analyses.latest({ kind: 'stack' })) {
    const data = stackDataSchema.safeParse(record.data).data
    if (!data) continue
    const view = stackGroupView(record, data, access)
    if (!view) continue
    if (!options.compare) {
      groups.push(view)
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- one small lookup per group
    const [earlier] = await analyses.list({
      repo: record.repo,
      kind: 'stack',
      before: new Date(Date.parse(record.createdAt) - WEEK + 3_600_000).toISOString(),
      limit: 1,
    })
    const before = earlier && stackDataSchema.safeParse(earlier.data).data
    const previous = before && stackGroupView(earlier, before, access)
    groups.push({
      ...view,
      ...(previous && earlier
        ? { changes: { since: earlier.createdAt, ...stackChanges(view, previous) } }
        : {}),
    })
  }
  return groups.toSorted((a, b) => a.group.localeCompare(b.group))
}

const kindRank = { prod: 0, peer: 1, optional: 2, dev: 3 } as const

/**
 * Direct dependencies of a repository from its newest `depgraph` record, one per library, runtime
 * dependencies before development ones, then by name.
 */
export async function repoDependencies(
  analyses: Pick<AnalysisStore, 'latest' | 'list'>,
  repo: RepoRef,
): Promise<{ ecosystem: string; name: string; version: string }[]> {
  const found = await latestDepgraphs(analyses, {
    accept: (record) => record.repo.forge === repo.forge && record.repo.path === repo.path,
  })
  const data = found.get(`${repo.forge}:${repo.path}`)?.data
  if (!data) return []
  const byLibrary = new Map<string, DirectDependency>()
  for (const dep of directDependencies(data)) {
    const key = `${dep.ecosystem}\0${dep.name}`
    const known = byLibrary.get(key)
    if (!known || kindRank[dep.kind] < kindRank[known.kind]) byLibrary.set(key, dep)
  }
  return [...byLibrary.values()]
    .toSorted((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name))
    .map(({ ecosystem, name, version }) => ({ ecosystem, name, version }))
}
