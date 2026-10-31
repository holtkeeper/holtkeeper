import type { BundleTargetReportView, BundleTargetsView } from '@holtkeeper/api'
import {
  type BundleRecordLike,
  isBundleAnalysisData,
  bundleSeries,
  findTargetPoint,
  targetReport,
} from '@holtkeeper/bundles'
import type { RepoRef } from '@holtkeeper/forge'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, authorize, parseRepo, repoTarget } from '../context.ts'

/** Records a history is built from; older measurements drop out of the charts. */
const MAX_RECORDS = 300

const repoParam = (value: string | undefined) => {
  const repo = parseRepo(value)
  if (!repo) throw new HTTPException(400, { message: 'repo is required' })
  return repo
}

/**
 * Bundle sizes by target: the history of every app build and published package of a repository,
 * and the report of one point of it. Built from `bundle` analysis records.
 */
export function bundleRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

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
