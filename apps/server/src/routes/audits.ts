import type { Principal } from '@holtkeeper/access'
import type {
  AuditFixesResponse,
  AuditRepoFixes,
  FindingsResponse,
  SettingView,
} from '@holtkeeper/api'
import { analyzerOff, repoAnalyzersKey } from '@holtkeeper/settings'
import { allowlistSchema, auditReportSchema } from '@holtkeeper/vuln'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { mainLineHeads } from '../analyses.ts'
import { diffChanges } from '../audit.ts'
import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  readBody,
  repoKey,
  repoTarget,
} from '../context.ts'
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

/** Distinct non-empty items of a comma-separated query value. */
const commaSet = (value: string | undefined) =>
  new Set(
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )

/**
 * `GET /api/audits/findings` (`supplyFor(caller).findings`,
 * optionally one `repo`), `GET /api/audits/fixes` (`AuditFixesResponse`) and `POST /api/audits/allowlist/renew`, which moves the expiry of one
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

  app.get('/audits/fixes', async (c) => {
    const principal = principalOf(c)
    const ids = commaSet(c.req.query('ids'))
    const wanted = commaSet(c.req.query('repos'))
    if (!ids.size) throw new HTTPException(400, { message: 'ids is required' })
    const [heads, switches] = await Promise.all([
      mainLineHeads(store.analyses, { kind: 'audit' }),
      store.settings.list(repoAnalyzersKey),
    ])
    const readable = heads.filter((head) => {
      const target = repoTarget(config, head.repo)
      return (
        (!wanted.size || wanted.has(repoKey(head.repo))) &&
        canSee(principal, 'audits:read', target) &&
        !analyzerOff(switches, target, 'audit')
      )
    })
    const repos = await Promise.all(
      readable.map(async (head): Promise<AuditRepoFixes[]> => {
        const record = await store.analyses.get(head.id)
        const report = auditReportSchema.safeParse(record?.data).data
        const fixes = (report?.fixes ?? []).filter((fix) =>
          fix.requested.some((requested) => ids.has(requested)),
        )
        return fixes.length
          ? [{ repo: repoKey(head.repo), analysisId: head.id, createdAt: head.createdAt, fixes }]
          : []
      }),
    )
    return c.json<AuditFixesResponse>({
      repos: repos.flat().toSorted((a, b) => a.repo.localeCompare(b.repo)),
    })
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
