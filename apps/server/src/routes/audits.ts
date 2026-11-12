import type { Principal } from '@holtkeeper/access'
import type { AuditRunDetail, AuditRunList, FindingsResponse, SettingView } from '@holtkeeper/api'
import { summarizeRun } from '@holtkeeper/api'
import { allowlistSchema } from '@holtkeeper/vuln'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { diffChanges } from '../audit.ts'
import {
  type Env,
  type ServerDeps,
  authorize,
  authorizeRecord,
  limitParam,
  parseRepo,
  principalOf,
  readBody,
  repoKey,
  repoTarget,
} from '../context.ts'
import { ingestAuditRunSchema } from '../schemas.ts'
import { allowlistEntryProblem, allowlistPolicyFor } from '../setting-rules.ts'
import type { SupplyToolsAccess } from '../tools/repos.ts'
import { canSee } from '../visibility.ts'

const renewSchema = z.object({
  settingId: z.string().min(1).max(200),
  advisory: z.string().min(1).max(200),
  package: z.string().min(1).max(200).optional(),
  expires: z.iso.date(),
  reason: z.string().trim().min(1).max(1000).optional(),
})

/**
 * Audit runs (list, read, ingest), `GET /api/audits/findings` (`supplyFor(caller).findings`,
 * optionally one `repo`) and `POST /api/audits/allowlist/renew`, which moves the expiry of one
 * `audit.allowlist` entry (and replaces its reason when one is given): `settings:write` on the
 * setting's scope, the `audit.allowlistPolicy` covering that scope (`maxDays`, `requireReason`),
 * last write wins, audited as `allowlist.renew`.
 */
export function auditRoutes(
  deps: ServerDeps,
  supplyFor: (principal: Principal) => SupplyToolsAccess,
) {
  const { config, store } = deps
  const app = new Hono<Env>()

  app.get('/audits/findings', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    const findings = await supplyFor(principalOf(c)).findings(
      repo ? { repos: [repoKey(repo)] } : {},
    )
    return c.json<FindingsResponse>(findings)
  })

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
    authorizeRecord(c, 'audits:read', { kind: 'repo', repo: repoTarget(config, run.repo) })
    return c.json<AuditRunDetail>({ run, summary: summarizeRun(run) })
  })

  app.post('/audit-runs', async (c) => {
    const input = await readBody(c, ingestAuditRunSchema)
    const principal = authorize(c, 'audits:run', {
      kind: 'repo',
      repo: repoTarget(config, input.repo),
    })
    const run = await store.auditRuns.add({ ...input, actor: principal.id })
    c.set('audit', {
      action: 'audit_run.ingest',
      target: { type: 'audit_run', id: run.id, repo: `${run.repo.forge}:${run.repo.path}` },
      details: {
        active: run.report.findings.length,
        resolved: run.report.resolved.length,
      },
    })
    return c.json<AuditRunDetail>({ run, summary: summarizeRun(run) }, 201)
  })

  app.post('/audits/allowlist/renew', async (c) => {
    const input = await readBody(c, renewSchema)
    c.set('audit', { action: 'allowlist.renew', target: { type: 'setting', id: input.settingId } })
    const previous = await store.settings.get(input.settingId)
    if (!previous || previous.key !== 'audit.allowlist')
      throw new HTTPException(404, { message: 'allowlist setting not found' })
    const principal = authorize(c, 'settings:write', { kind: 'scope', scope: previous.scope })
    const today = deps.now().toISOString().slice(0, 10)
    if (input.expires < today)
      throw new HTTPException(400, { message: 'expires must not be in the past' })
    const parsed = allowlistSchema.safeParse(previous.value)
    if (!parsed.success)
      throw new HTTPException(409, {
        message: 'the stored allowlist is not valid; edit it in full',
      })
    const index = parsed.data.findIndex(
      (entry) => entry.id === input.advisory && entry.package === input.package,
    )
    const found = parsed.data[index]
    if (!found) throw new HTTPException(404, { message: 'allowlist entry not found' })
    const renewed = {
      ...found,
      expires: input.expires,
      ...(input.reason !== undefined && { reason: input.reason }),
    }
    const problem = allowlistEntryProblem(
      allowlistPolicyFor(await store.settings.list(), previous.scope),
      renewed,
      today,
    )
    if (problem) throw new HTTPException(400, { message: problem })
    const value = parsed.data.with(index, renewed)
    const entry = {
      ...previous,
      value,
      updatedAt: deps.now().toISOString(),
      updatedBy: principal.id,
    }
    await store.settings.put(entry)
    c.set('audit', {
      action: 'allowlist.renew',
      target: { type: 'setting', id: entry.id },
      changes: diffChanges(
        { expires: found.expires, reason: found.reason },
        { expires: renewed.expires, reason: renewed.reason },
      ),
      details: {
        key: entry.key,
        advisory: input.advisory,
        ...(input.package && { package: input.package }),
      },
    })
    return c.json<SettingView>({
      id: entry.id,
      key: entry.key,
      scope: entry.scope,
      value: entry.value,
      secret: false,
      updatedAt: entry.updatedAt,
      updatedBy: principal.id,
    })
  })

  return app
}
