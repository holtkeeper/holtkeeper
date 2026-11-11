import { type Principal, can } from '@holtkeeper/access'
import type { AuditVerifyResponse, HistoryList, HistoryScope } from '@holtkeeper/api'
import {
  type AuditFilter,
  type AuditOutcome,
  type AuditVia,
  formatAuditEvents,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { appendAudit, auditActorOf } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  limitParam,
  parseRepo,
  principalOf,
  repoTarget,
} from '../context.ts'
import { canSee } from '../visibility.ts'
import { peopleOf } from './avatars.ts'

const outcomes: readonly AuditOutcome[] = ['ok', 'denied', 'error']
const vias: readonly AuditVia[] = ['ui', 'api', 'webhook', 'job', 'system']

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string) {
  if (value === undefined || value === '') return undefined
  const found = allowed.find((candidate) => candidate === value)
  if (found === undefined)
    throw new HTTPException(400, { message: `${name} must be one of ${allowed.join(', ')}` })
  return found
}

function timestamp(value: string | undefined, name: string) {
  if (!value) return undefined
  if (Number.isNaN(Date.parse(value)))
    throw new HTTPException(400, { message: `${name} must be an ISO timestamp` })
  return new Date(value).toISOString()
}

function seqParam(value: string | undefined, name: string) {
  if (!value) return undefined
  if (!/^\d+$/.test(value))
    throw new HTTPException(400, { message: `${name} must be a positive integer` })
  return Number(value)
}

const reposParam = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean)

function filterOf(c: AppContext): AuditFilter {
  const q = (name: string) => c.req.query(name) || undefined
  const outcome = oneOf(q('outcome'), outcomes, 'outcome')
  const via = oneOf(q('via'), vias, 'via')
  const from = timestamp(q('from'), 'from')
  const to = timestamp(q('to'), 'to')
  const repos = reposParam(c.req.query('repos'))
  return {
    ...(q('actor') && { actor: q('actor') }),
    ...(q('action') && { action: q('action') }),
    ...(q('targetType') && { targetType: q('targetType') }),
    ...(q('targetId') && { targetId: q('targetId') }),
    ...(q('repo') && { repo: q('repo') }),
    ...(repos && { repos }),
    ...(outcome && { outcome }),
    ...(via && { via }),
    ...(from && { from }),
    ...(to && { to }),
  }
}

const GLOBAL = { kind: 'global' } as const

const readAll = (principal: Principal) => can(principal, 'audit:read', GLOBAL)

const reachable = (principal: Principal) =>
  readAll(principal) ||
  principal.grants.some((grant) =>
    grant.actions.some((action) => action === '*' || action === 'repos:read'),
  )

/**
 * The audit log as the History page reads it, plus the compliance tools. `GET /history` pages
 * through the events the caller may see: everything with global `audit:read`; otherwise only events
 * about repositories it can `repos:read`, never instance-level ones. `GET /history/scope` lists those
 * repositories with their groups. CSV/NDJSON export (itself audited as `audit.export`) and hash
 * chain verification need global `audit:read`.
 */
export function auditLogRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const audit = deps.store.audit

  const visibleRepos = async (principal: Principal) =>
    (await audit.repos()).flatMap((key) => {
      const ref = parseRepo(key)
      if (!ref) return []
      const target = repoTarget(deps.config, ref)
      return canSee(principal, 'repos:read', target) ? [{ repo: key, groups: target.groups }] : []
    })

  app.get('/history', async (c) => {
    const principal = principalOf(c)
    if (!reachable(principal))
      throw new HTTPException(403, { message: 'missing permission repos:read' })
    const { repos: requested, ...filter } = filterOf(c)
    let repos = requested
    if (!readAll(principal)) {
      const visible = new Set((await visibleRepos(principal)).map((entry) => entry.repo))
      repos = (requested ?? [...visible]).filter((repo) => visible.has(repo))
    }
    const page = await audit.list({
      ...filter,
      ...(repos && { repos }),
      ...(c.req.query('cursor') && { cursor: c.req.query('cursor') }),
      limit: limitParam(c.req.query('limit')),
    })
    return c.json<HistoryList>({
      ...page,
      people: await peopleOf(
        deps,
        page.events.map((event) => event.actor.id),
      ),
    })
  })

  app.get('/history/scope', async (c) => {
    const principal = principalOf(c)
    if (!reachable(principal))
      throw new HTTPException(403, { message: 'missing permission repos:read' })
    return c.json<HistoryScope>({
      repos: await visibleRepos(principal),
      instance: readAll(principal),
    })
  })

  app.get('/audit/export', async (c) => {
    authorize(c, 'audit:read', GLOBAL)
    const format = oneOf(c.req.query('format') ?? 'ndjson', ['csv', 'ndjson'] as const, 'format')
    const filter = filterOf(c)
    await appendAudit(deps.store, {
      at: deps.now().toISOString(),
      actor: auditActorOf(c.get('principal'), deps.auth.name),
      via: c.req.header('sec-fetch-site') !== undefined ? 'ui' : 'api',
      action: 'audit.export',
      target: { type: 'audit' },
      outcome: 'ok',
      status: 200,
      request: { method: 'GET', path: c.req.path, route: '/api/audit/export' },
      details: { format, filter },
    })
    const chunks = formatAuditEvents(audit.export(filter), format ?? 'ndjson')
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      },
      async cancel() {
        await chunks.return(undefined)
      },
    })
    const stamp = deps.now().toISOString().slice(0, 10)
    return new Response(body, {
      headers: {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
        'content-disposition': `attachment; filename="holtkeeper-audit-${stamp}.${format === 'csv' ? 'csv' : 'ndjson'}"`,
        'cache-control': 'no-store',
      },
    })
  })

  app.get('/audit/verify', async (c) => {
    authorize(c, 'audit:read', GLOBAL)
    const fromSeq = seqParam(c.req.query('fromSeq'), 'fromSeq')
    const toSeq = seqParam(c.req.query('toSeq'), 'toSeq')
    return c.json<AuditVerifyResponse>(
      await audit.verifyChain({
        ...(fromSeq !== undefined && { fromSeq }),
        ...(toSeq !== undefined && { toSeq }),
      }),
    )
  })

  return app
}
