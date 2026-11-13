import type { BundleTargetReportView, BundleTargetsView, BundlesOverview } from '@holtkeeper/api'
import {
  type BundleRecordLike,
  bundleSeries,
  findTargetPoint,
  isBundleAnalysisData,
  targetReport,
} from '@holtkeeper/bundles'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisHead } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { LINE_SCAN, latestHeadsWithMetrics, mainLineRecords } from '../analyses.ts'
import { OVERVIEW_RECORDS, bundlesRow } from '../bundles.ts'
import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  repoKey,
  repoTarget,
} from '../context.ts'
import { createFleetCache } from '../fleet-cache.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import { BUNDLE_SETTING } from '../repo-health.ts'
import { canSee } from '../visibility.ts'

/** Records a history is built from; older measurements drop out of the charts. */
const MAX_RECORDS = 300

const KIND = 'bundle'

const repoParam = (value: string | undefined) => {
  const repo = parseRepo(value)
  if (!repo) throw new HTTPException(400, { message: 'repo is required' })
  return repo
}

/**
 * Bundle sizes by target: `GET /bundles` gives a row per repository the caller may read and whose
 * `bundle` analyzer `repo.analyzers` does not turn off, from the stored metrics of its newest
 * main-line records; `/bundles/targets` the history of every app build and
 * published package of one repository and `/bundles/report` the report of one point of it, both
 * from record data.
 */
export function bundleRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const cache = createFleetCache()

  const lineOf = async (newest: AnalysisHead) => {
    const line = mainLineRecords(
      await store.analyses.heads({ repo: newest.repo, kind: KIND, limit: LINE_SCAN }),
      OVERVIEW_RECORDS,
    )
    return line.map((head) => (head.id === newest.id ? newest : head))
  }

  app.get('/bundles', async (c) => {
    const principal = principalOf(c)
    const [newest, settings, off] = await Promise.all([
      latestHeadsWithMetrics(store.analyses, kinds, { kind: KIND }),
      store.settings.list(BUNDLE_SETTING),
      analyzerOffFilter(store, (repo) => repoTarget(config, repo), KIND),
    ])
    const visible = newest.filter(
      (head) =>
        canSee(principal, 'analyses:read', repoTarget(config, head.repo)) && !off(head.repo),
    )
    const repos = await cache.read(
      {
        endpoint: `bundles?settings=${settings
          .map((entry) => `${entry.id}@${entry.updatedAt}`)
          .toSorted()
          .join(',')}`,
        analysisIds: visible.map((head) => head.id),
        repos: visible.map((head) => repoKey(head.repo)),
      },
      async () => {
        const rows = await Promise.all(
          visible.map(async (head) =>
            bundlesRow(repoTarget(config, head.repo), await lineOf(head), settings),
          ),
        )
        return rows
          .filter((row) => row !== undefined)
          .toSorted((a, b) => repoKey(a.repo).localeCompare(repoKey(b.repo)))
      },
    )
    return c.json<BundlesOverview>({ repos })
  })

  const recordsOf = async (repo: RepoRef): Promise<BundleRecordLike[]> =>
    (await store.analyses.list({ repo, kind: 'bundle', limit: MAX_RECORDS })).flatMap((record) =>
      isBundleAnalysisData(record.data)
        ? [
            {
              id: record.id,
              createdAt: record.createdAt,
              ...(record.ref ? { ref: record.ref } : {}),
              data: record.data,
            },
          ]
        : [],
    )

  app.get('/bundles/targets', async (c) => {
    const repo = repoParam(c.req.query('repo'))
    authorize(c, 'analyses:read', { kind: 'repo', repo: repoTarget(config, repo) })
    const records = await recordsOf(repo)
    return c.json<BundleTargetsView>({ series: bundleSeries(records), records: records.length })
  })

  app.get('/bundles/report', async (c) => {
    const repo = repoParam(c.req.query('repo'))
    authorize(c, 'analyses:read', { kind: 'repo', repo: repoTarget(config, repo) })
    const name = c.req.query('target')
    if (!name) throw new HTTPException(400, { message: 'target is required' })
    const version = c.req.query('version')
    const analysisId = c.req.query('analysis')
    const found = findTargetPoint(await recordsOf(repo), {
      name,
      ...(version ? { version } : {}),
      ...(analysisId ? { analysisId } : {}),
    })
    if (!found) throw new HTTPException(404, { message: 'no such measurement' })
    const { current, previous } = found
    const report = targetReport(
      { target: current.target, repo, ...(current.record.ref ? { ref: current.record.ref } : {}) },
      previous && {
        target: previous.target,
        ...(previous.record.ref ? { ref: previous.record.ref } : {}),
      },
    )
    return c.json<BundleTargetReportView>({
      report,
      analysisId: current.record.id,
      ...(previous ? { previousAnalysisId: previous.record.id } : {}),
    })
  })

  return app
}
