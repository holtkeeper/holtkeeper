import type { Principal } from '@holtkeeper/access'
import {
  type AuditActor,
  type AuditChange,
  type AuditEvent,
  type AuditEventInput,
  type AuditOutcome,
  type AuditTarget,
  type AuditVia,
  type Store,
  type Timestamp,
  type User,
  canonicalJson,
} from '@holtkeeper/store'
import type { MiddlewareHandler } from 'hono'

import type { AppContext, Env, ServerDeps } from './context.ts'

/** What a route may add to the audit event of its request with `c.set('audit', …)`. */
export interface AuditEnrichment {
  /** Replaces the action derived from the route, e.g. `credential.rotate`. */
  action?: string
  /** Merged over the target derived from the route. */
  target?: Partial<AuditTarget>
  changes?: AuditChange[]
  details?: Record<string, unknown>
}

/** Stands in for secret values in `changes`. */
export const REDACTED = '«redacted»'

const secretKey =
  /secret|password|passphrase|token|api[-_]?key|private[-_]?key|authorization|cookie/i

/** Whether a field (any segment of a dotted path) holds a secret by its name. */
const isSecretField = (field: string) => field.split('.').some((part) => secretKey.test(part))

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function flatten(value: unknown, prefix: string, out: Map<string, unknown>) {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, item] of Object.entries(value))
      flatten(item, prefix ? `${prefix}.${key}` : key, out)
  } else if (value !== undefined) {
    out.set(prefix, value)
  }
  return out
}

/**
 * Field-level differences between two versions of an object (nested objects as dotted paths,
 * arrays compared whole), sorted by field. Fields whose name looks secret, or that `secret`
 * selects, show `«redacted»` instead of their values. A missing side is a creation or removal.
 */
export function diffChanges(
  before: unknown,
  after: unknown,
  options: { secret?: (field: string) => boolean; ignore?: string[] } = {},
): AuditChange[] {
  const a = flatten(before, '', new Map())
  const b = flatten(after, '', new Map())
  const ignored = new Set(options.ignore ?? [])
  const fields = [...new Set([...a.keys(), ...b.keys()])]
    .filter((field) => !ignored.has(field) && !ignored.has(field.split('.')[0] ?? ''))
    .toSorted()
  const changes: AuditChange[] = []
  for (const field of fields) {
    const was = a.get(field)
    const now = b.get(field)
    if (canonicalJson(was) === canonicalJson(now)) continue
    const hide = isSecretField(field) || options.secret?.(field) === true
    changes.push({
      field,
      ...(was !== undefined && { before: hide ? REDACTED : was }),
      ...(now !== undefined && { after: hide ? REDACTED : now }),
    })
  }
  return changes
}

/** The audit actor of a principal, or of an anonymous caller. */
export const auditActorOf = (principal: Principal | undefined, provider: string): AuditActor =>
  principal
    ? { id: principal.id, name: principal.name, provider: principal.provider }
    : { id: 'anonymous', name: 'anonymous', provider }

/** An event for `appendAudit`; `at` defaults to now. */
export type AuditAppend = Omit<AuditEventInput, 'at'> & { at?: Timestamp }

/**
 * Appends one event to `store.audit` and returns it; `undefined` when the store has no audit log
 * or the append failed (logged, never thrown, so auditing cannot break the action itself).
 * Webhooks and jobs use it with `via: 'webhook' | 'job'` and an actor such as
 * `{ id: 'gitlab:work:42', name: 'jane', provider: 'gitlab:work' }` or
 * `{ id: 'system', name: 'scheduler', provider: 'job' }`.
 */
export async function appendAudit(
  store: Pick<Store, 'audit'>,
  event: AuditAppend,
): Promise<AuditEvent | undefined> {
  if (!store.audit) return undefined
  try {
    return await store.audit.append({ ...event, at: event.at ?? new Date().toISOString() })
  } catch (error) {
    console.error('audit: append failed', error)
    return undefined
  }
}

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const singular = (word: string) =>
  word.endsWith('ses')
    ? `${word.slice(0, -3)}sis`
    : word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1)
      : word

const verbs: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
}

type Segment = { name: string; param: boolean; value: string }

/** Route segments after `/api` or `/auth/<provider>`, params marked. */
function segmentsOf(route: string, path: string, params: Record<string, string>): Segment[] {
  const routeParts = route.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)
  const skip = routeParts[0] === 'api' ? 1 : 2
  return routeParts.slice(skip).map((part, index) => {
    const param = part.startsWith(':')
    const name = param ? (part.slice(1).split('{')[0] ?? '') : part
    return { name, param, value: param ? (params[name] ?? pathParts[index + skip] ?? '') : part }
  })
}

/** `<object>.<verb>` and the target of a request, from its route template. */
export function deriveAction(
  method: string,
  route: string,
  path: string,
  params: Record<string, string>,
): { action: string; target: AuditTarget } {
  const segments = segmentsOf(route, path, params).filter(
    (s) => s.name !== 'admin' && s.name !== '*',
  )
  const statics = segments.filter((s) => !s.param)
  const resource = singular(statics[0]?.name ?? 'request')
  const last = segments.at(-1)
  const firstParam = segments.find((s) => s.param)
  const target: AuditTarget = {
    type: resource,
    ...(firstParam?.value && { id: firstParam.value }),
  }
  const verb = verbs[method] ?? method.toLowerCase()
  if (!last || statics.length <= 1 || last.param) {
    if (last?.param && last.name === 'action')
      return { action: `${resource}.${last.value}`, target }
    const owner = last?.param ? segments.at(-2)?.name : undefined
    const object = owner ? singular(owner) : resource
    const id = last?.param ? last.value : undefined
    return {
      action: `${object}.${verb}`,
      target: object === resource ? target : { type: object, ...(id && { id }) },
    }
  }
  if (method === 'POST' && last.name.endsWith('s') && !last.name.endsWith('ss'))
    return { action: `${singular(last.name)}.create`, target }
  return { action: `${resource}.${last.name}`, target }
}

/** Route template and params for provider endpoints, which Hono only sees as `/auth/<name>/*`. */
function authRoute(path: string): { route: string; params: Record<string, string> } {
  const parts = path.split('/')
  const admin = parts.indexOf('admin')
  const params: Record<string, string> = {}
  const route = parts.map((part, index) => {
    const offset = index - admin
    if (admin < 0 || offset < 2 || offset % 2 === 1) return part
    const owner = parts[index - 1] ?? ''
    const name = offset === 2 ? 'id' : `${singular(owner)}Id`
    params[name] = part
    return `:${name}`
  })
  return { route: route.join('/'), params }
}

const outcomeOf = (status: number): AuditOutcome =>
  status === 401 || status === 403 ? 'denied' : status >= 400 ? 'error' : 'ok'

function viaOf(c: AppContext, path: string): AuditVia {
  if (path.startsWith('/api/webhooks')) return 'webhook'
  return c.req.header('sec-fetch-site') !== undefined ? 'ui' : 'api'
}

function ipOf(c: AppContext): string | undefined {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  const real = c.req.header('x-real-ip')
  if (real) return real
  const env: unknown = c.env
  if (isPlainObject(env) && typeof env.requestIP === 'function') {
    try {
      const address: unknown = env.requestIP(c.req.raw)
      if (isPlainObject(address) && typeof address.address === 'string') return address.address
    } catch {
      return undefined
    }
  }
  return undefined
}

const userFields = (user: User | undefined) =>
  user && {
    name: user.name,
    email: user.email,
    grants: user.grants,
    disabled: user.disabled,
    avatarSeed: user.avatarSeed,
  }

/** Whether a request is audited: mutating methods under `/api` and `/auth/<provider>/admin`. */
function isAudited(method: string, path: string, provider: string) {
  return (
    mutating.has(method) &&
    (path.startsWith('/api/') || path.startsWith(`/auth/${provider}/admin/`))
  )
}

/**
 * Audits every mutating request under `/api` and `/auth/<provider>/admin` once the response is
 * ready: actor, route template and params, status, duration and outcome (401/403 are `denied`).
 * Routes enrich the event with `c.set('audit', …)`; user changes made through the `users`
 * provider get field-level `changes` from the stored user before and after.
 */
export function auditMiddleware(
  deps: Pick<ServerDeps, 'store' | 'auth' | 'now'>,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const method = c.req.method
    const path = c.req.path
    if (!deps.store.audit || !isAudited(method, path, deps.auth.name)) return next()

    const started = performance.now()
    const auth = path.startsWith('/auth/') ? authRoute(path) : undefined
    const userId =
      auth?.route.endsWith('/admin/users/:id') && method === 'PATCH' ? auth.params.id : undefined
    const userBefore = userId ? await deps.store.users.getUser(userId) : undefined

    await next()

    const status = c.res.status
    const route = auth?.route ?? c.req.routePath
    const params = auth?.params ?? c.req.param()
    const derived = deriveAction(method, route, path, params)
    const enrichment = c.get('audit')
    let changes = enrichment?.changes
    if (userId && !changes && status < 400) {
      changes = diffChanges(
        userFields(userBefore),
        userFields(await deps.store.users.getUser(userId)),
      )
    }
    const repo = c.req.query('repo')
    const ip = ipOf(c)
    const userAgent = c.req.header('user-agent')
    await appendAudit(deps.store, {
      at: deps.now().toISOString(),
      actor: auditActorOf(c.get('principal'), deps.auth.name),
      via: viaOf(c, path),
      action: enrichment?.action ?? derived.action,
      target: {
        ...derived.target,
        ...(repo && { repo }),
        ...enrichment?.target,
      },
      outcome: outcomeOf(status),
      status,
      request: {
        method,
        path,
        route,
        ...(Object.keys(params).length > 0 && { params }),
        ...(ip && { ip }),
        ...(userAgent && { userAgent }),
        durationMs: Math.round(performance.now() - started),
      },
      ...(changes && changes.length > 0 && { changes }),
      ...(enrichment?.details && { details: enrichment.details }),
    })
  }
}

/** Applies `retentionDays` to the audit log every `intervalMs` (default daily); returns a stop function. */
export function startAuditRetention(
  store: Pick<Store, 'audit'>,
  options: {
    retentionDays?: number
    intervalMs?: number
    now?: () => Date
    log?: (line: string) => void
  } = {},
): () => void {
  const audit = store.audit
  const days = options.retentionDays ?? 365
  if (!audit || !(days > 0)) return () => {}
  const now = options.now ?? (() => new Date())
  const sweep = async () => {
    try {
      const removed = await audit.sweep(new Date(now().getTime() - days * 86_400_000).toISOString())
      if (removed) options.log?.(`audit: removed ${removed} events older than ${days} days`)
    } catch (error) {
      options.log?.(
        `audit: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  void sweep()
  const timer = setInterval(() => void sweep(), options.intervalMs ?? 86_400_000)
  return () => clearInterval(timer)
}
