import type { AuditList, AuditVerifyResponse } from '@holtkeeper/api'
import {
  type AuditFilter,
  type AuditOutcome,
  type AuditStore,
  type AuditVia,
  formatAuditEvents,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { appendAudit, auditActorOf } from '../audit.ts'
import { type AppContext, type Env, type ServerDeps, authorize, limitParam } from '../context.ts'

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

function filterOf(c: AppContext): AuditFilter {
  const q = (name: string) => c.req.query(name) || undefined
  const outcome = oneOf(q('outcome'), outcomes, 'outcome')
  const via = oneOf(q('via'), vias, 'via')
  const from = timestamp(q('from'), 'from')
  const to = timestamp(q('to'), 'to')
  return {
    ...(q('actor') && { actor: q('actor') }),
    ...(q('action') && { action: q('action') }),
    ...(q('targetType') && { targetType: q('targetType') }),
    ...(q('targetId') && { targetId: q('targetId') }),
    ...(q('repo') && { repo: q('repo') }),
    ...(outcome && { outcome }),
    ...(via && { via }),
    ...(from && { from }),
    ...(to && { to }),
  }
}

/**
 * The audit log, readable with global `audit:read`: paged listing with filters, CSV/NDJSON export
 * (itself audited as `audit.export`) and hash chain verification. 503 without an audit store.
 */
export function auditLogRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const auditOf = (c: AppContext): AuditStore => {
    authorize(c, 'audit:read', { kind: 'global' })
    if (!deps.store.audit) throw new HTTPException(503, { message: 'no audit log is configured' })
    return deps.store.audit
  }

  app.get('/audit', async (c) => {
    const audit = auditOf(c)
    const page = await audit.list({
      ...filterOf(c),
      ...(c.req.query('cursor') && { cursor: c.req.query('cursor') }),
      limit: limitParam(c.req.query('limit')),
    })
    return c.json<AuditList>(page)
  })

  app.get('/audit/count', async (c) => c.json({ count: await auditOf(c).count(filterOf(c)) }))

  app.get('/audit/export', async (c) => {
    const audit = auditOf(c)
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
    const audit = auditOf(c)
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
