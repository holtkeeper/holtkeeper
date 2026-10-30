import type {
  AnalysisSummary,
  AuditRunDetail,
  AuditRunList,
  RepoList,
  RepoSummary,
} from '@holtkeeper/api'
import { summarizeRun } from '@holtkeeper/api'
import { staticPrefix } from '@holtkeeper/jobs'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { summarizeAnalysis } from '../analyses.ts'
import {
  type Env,
  type ServerDeps,
  authorize,
  limitParam,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { ingestAuditRunSchema } from '../schemas.ts'
import { canSee } from '../visibility.ts'

/** Audit runs and the repositories they cover. */
export function auditRoutes(deps: ServerDeps) {
  const { config, store } = deps
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const app = new Hono<Env>()

  app.get('/audit-runs', async (c) => {
    const principal = principalOf(c)
    const repo = parseRepo(c.req.query('repo'))
    const runs = await store.auditRuns.list({
      ...(repo ? { repo } : {}),
      ...(c.req.query('before') ? { before: c.req.query('before') } : {}),
      limit: limitParam(c.req.query('limit')),
    })
    const visible = runs.filter((run) =>
      canSee(principal, 'audits:read', repoTarget(config, run.repo)),
    )
    return c.json<AuditRunList>({ runs: visible.map(summarizeRun) })
  })

  app.get('/audit-runs/:id', async (c) => {
    const run = await store.auditRuns.get(c.req.param('id'))
    if (!run) throw new HTTPException(404, { message: 'audit run not found' })
    authorize(c, 'audits:read', { kind: 'repo', repo: repoTarget(config, run.repo) })
    return c.json<AuditRunDetail>({ run, summary: summarizeRun(run) })
  })

  app.post('/audit-runs', async (c) => {
    const input = await readBody(c, ingestAuditRunSchema)
    const principal = authorize(c, 'audits:run', {
      kind: 'repo',
      repo: repoTarget(config, input.repo),
    })
    const run = await store.auditRuns.add({ ...input, actor: principal.id })
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'audit.ingested',
      subject: `${run.repo.forge}:${run.repo.path}`,
      details: {
        runId: run.id,
        active: run.report.findings.length,
        resolved: run.report.resolved.length,
      },
    })
    return c.json<AuditRunDetail>({ run, summary: summarizeRun(run) }, 201)
  })

  app.get('/repos', async (c) => {
    const principal = principalOf(c)
    const latest = new Map<string, RepoSummary>()
    for (const run of await store.auditRuns.list({ limit: 500 })) {
      const key = `${run.repo.forge}:${run.repo.path}`
      if (latest.has(key)) continue
      const target = repoTarget(config, run.repo)
      if (!canSee(principal, 'repos:read', target) && !canSee(principal, 'audits:read', target))
        continue
      latest.set(key, {
        repo: run.repo,
        groups: target.groups,
        ...(canSee(principal, 'audits:read', target) ? { latestAudit: summarizeRun(run) } : {}),
      })
    }
    for (const group of Object.values(config.groups)) {
      for (const path of group.include) {
        if (staticPrefix(path) !== path) continue
        const key = `${group.forge}:${path}`
        if (latest.has(key)) continue
        const target = repoTarget(config, { forge: group.forge, path })
        if (!target.groups.length) continue
        if (!canSee(principal, 'repos:read', target) && !canSee(principal, 'audits:read', target))
          continue
        latest.set(key, { repo: { forge: group.forge, path }, groups: target.groups })
      }
    }
    await Promise.all(
      [...latest.values()].map(async (summary) => {
        if (!canSee(principal, 'analyses:read', repoTarget(config, summary.repo))) return
        const newest = new Map<string, AnalysisSummary>()
        for (const record of await store.analyses.list({ repo: summary.repo, limit: 100 }))
          if (!newest.has(record.kind)) newest.set(record.kind, summarizeAnalysis(kinds, record))
        if (newest.size) summary.latestAnalyses = [...newest.values()]
      }),
    )
    const repos = [...latest.values()].toSorted((a, b) =>
      `${a.repo.forge}:${a.repo.path}`.localeCompare(`${b.repo.forge}:${b.repo.path}`),
    )
    return c.json<RepoList>({ repos })
  })

  return app
}
