import type {
  DependencyUpdatesOverview,
  FleetUpdate,
  RepoUpdates,
  UpdateMergeRequest,
  UpdateState,
} from '@holtkeeper/api'
import { browserslistDataSchema } from '@holtkeeper/browserslist'
import type { RepoRef } from '@holtkeeper/forge'
import { propagationDataSchema } from '@holtkeeper/propagate'
import { isBroken, mergeRequestStatus, renovateDataSchema } from '@holtkeeper/renovate'
import type { AnalysisRecord } from '@holtkeeper/store'

const RECENT_MS = 30 * 86_400_000
const FLEET_LIMIT = 100

const stateOrder: UpdateState[] = ['broken', 'review', 'outdated', 'current', 'unknown']

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

function renovateStatus(
  mr: Parameters<typeof mergeRequestStatus>[0],
): UpdateMergeRequest['status'] {
  if (mr.state !== 'open') return mr.state
  if (isBroken(mr)) return 'broken'
  if (mr.draft) return 'draft'
  return mergeRequestStatus(mr).text === 'checking' ? 'checking' : 'review'
}

function stateOf(entry: RepoUpdates): UpdateState {
  const open = entry.mergeRequests.filter((mr) => mr.status !== 'merged' && mr.status !== 'closed')
  if (
    entry.renovate?.status === 'failed' ||
    entry.browserslist?.status === 'failed' ||
    entry.propagation?.status === 'failed' ||
    entry.propagation?.status === 'error' ||
    open.some((mr) => mr.status === 'broken')
  )
    return 'broken'
  if (open.length) return 'review'
  if (!entry.renovate) return 'unknown'
  return entry.renovate.outdated > 0 ? 'outdated' : 'current'
}

/**
 * Joins the newest `renovate` and `browserslist` record of every repository and the newest
 * `propagation` record of every group into one row per repository, worst state first, plus the
 * dependencies the most repositories have updates for. `visible` drops repositories the caller
 * may not read; records whose data no longer matches their schema are skipped.
 */
export function dependencyUpdatesOverview(input: {
  records: AnalysisRecord[]
  visible?: (repo: RepoRef) => boolean
  now?: Date
}): DependencyUpdatesOverview {
  const visible = input.visible ?? (() => true)
  const since = (input.now ?? new Date()).getTime() - RECENT_MS
  const rows = new Map<string, RepoUpdates>()
  const rowOf = (repo: RepoRef) => {
    const key = keyOf(repo)
    let row = rows.get(key)
    if (!row) {
      row = { repo, state: 'unknown', mergeRequests: [] }
      rows.set(key, row)
    }
    return row
  }
  const fleet = new Map<string, FleetUpdate & { versions: Set<string> }>()

  const newestFirst = input.records.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const record of newestFirst) {
    if (record.kind === 'renovate') {
      if (!visible(record.repo) || rows.get(keyOf(record.repo))?.renovate) continue
      const data = renovateDataSchema.safeParse(record.data).data
      if (!data) continue
      const row = rowOf(record.repo)
      row.renovate = {
        analysisId: record.id,
        createdAt: record.createdAt,
        status: data.status,
        mode: data.mode,
        dependencies: data.dependencies,
        outdated: data.outdated,
        majors: data.updates.filter((u) => u.type === 'major').length,
        security: data.updates.filter((u) => u.vulnerability).length,
        pending: data.updates.filter((u) => u.pending).length,
        ...(data.libYears !== undefined && { libYears: data.libYears }),
      }
      for (const mr of data.mergeRequests) {
        if (mr.state !== 'open' && (mr.mergedAt ? Date.parse(mr.mergedAt) < since : true)) continue
        row.mergeRequests.push({
          source: 'renovate',
          id: mr.id,
          ...(mr.url && { url: mr.url }),
          title: mr.title,
          status: renovateStatus(mr),
          ...(mr.mergedAt && { mergedAt: mr.mergedAt }),
        })
      }
      const seen = new Set<string>()
      for (const update of data.updates) {
        const id = `${update.manager}:${update.dependency}`
        let entry = fleet.get(id)
        if (!entry) {
          entry = {
            dependency: update.dependency,
            manager: update.manager,
            repos: [],
            majors: 0,
            security: false,
            versions: new Set(),
          }
          fleet.set(id, entry)
        }
        if (!seen.has(id)) {
          seen.add(id)
          entry.repos.push(keyOf(record.repo))
          if (data.updates.some((u) => u.type === 'major' && `${u.manager}:${u.dependency}` === id))
            entry.majors += 1
        }
        if (update.vulnerability) entry.security = true
        if (update.next) entry.versions.add(update.next)
      }
    } else if (record.kind === 'browserslist') {
      if (!visible(record.repo) || rows.get(keyOf(record.repo))?.browserslist) continue
      const data = browserslistDataSchema.safeParse(record.data).data
      if (!data) continue
      const row = rowOf(record.repo)
      row.browserslist = {
        analysisId: record.id,
        createdAt: record.createdAt,
        status: data.status,
        ...(data.after.length && { version: data.after.at(-1) }),
      }
      if (data.status === 'updated' && data.mergeRequest)
        row.mergeRequests.push({
          source: 'browserslist',
          id: data.mergeRequest.id,
          url: data.mergeRequest.url,
          title: 'Update the browserslist database',
          status: data.mergeRequest.draft ? 'draft' : 'review',
        })
    } else if (record.kind === 'propagation') {
      const data = propagationDataSchema.safeParse(record.data).data
      if (!data) continue
      for (const outcome of data.repos) {
        const repo = { forge: record.repo.forge, path: outcome.repo }
        if (!visible(repo) || rows.get(keyOf(repo))?.propagation) continue
        if (outcome.status === 'skipped' || outcome.status === 'unchanged') continue
        const row = rowOf(repo)
        row.propagation = {
          analysisId: record.id,
          createdAt: record.createdAt,
          packages: data.packages.map((target) => target.name),
          status: outcome.status,
        }
        if (outcome.mergeRequest)
          row.mergeRequests.push({
            source: 'propagate',
            id: outcome.mergeRequest.id,
            url: outcome.mergeRequest.url,
            title: `Update ${row.propagation.packages.join(', ')}`,
            status:
              outcome.status === 'failed'
                ? 'broken'
                : outcome.mergeRequest.draft
                  ? 'draft'
                  : 'review',
          })
      }
    }
  }

  const repos = [...rows.values()]
  for (const row of repos) row.state = stateOf(row)
  repos.sort(
    (a, b) =>
      stateOrder.indexOf(a.state) - stateOrder.indexOf(b.state) ||
      (b.renovate?.outdated ?? 0) - (a.renovate?.outdated ?? 0) ||
      keyOf(a.repo).localeCompare(keyOf(b.repo)),
  )

  const totals: DependencyUpdatesOverview['totals'] = {
    repos: repos.length,
    broken: 0,
    review: 0,
    outdated: 0,
    current: 0,
    unknown: 0,
    openMergeRequests: 0,
    merged: 0,
    security: 0,
  }
  for (const row of repos) {
    totals[row.state] += 1
    totals.security += row.renovate?.security ?? 0
    for (const mr of row.mergeRequests)
      if (mr.status === 'merged') totals.merged += 1
      else if (mr.status !== 'closed') totals.openMergeRequests += 1
  }

  const dependencies = [...fleet.values()]
    .map(({ versions, ...entry }) => {
      const latest = [...versions].toSorted((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      )[0]
      return { ...entry, ...(latest && { latest }) }
    })
    .toSorted(
      (a, b) =>
        Number(b.security) - Number(a.security) ||
        b.repos.length - a.repos.length ||
        b.majors - a.majors ||
        a.dependency.localeCompare(b.dependency),
    )
    .slice(0, FLEET_LIMIT)

  return { totals, repos, dependencies }
}
