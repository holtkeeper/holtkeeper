import { type Scope, can, scopeCoversRepo } from '@holtkeeper/access'
import type { KnowledgeDetail, KnowledgeEntryView, KnowledgeList } from '@holtkeeper/api'
import { knowledgeKinds, knowledgeStatuses, validateEntry } from '@holtkeeper/knowledge'
import type {
  KnowledgeEntry,
  KnowledgeFilter,
  KnowledgeKind,
  KnowledgeStatus,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { diffChanges } from '../audit.ts'
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

const scopeTarget = (scope: Scope) => ({ kind: 'scope' as const, scope })

/** Candidates ranked before the repository filter, so filtering does not starve `limit`. */
const pool = 500

const statusFor = { accept: 'accepted', reject: 'rejected', archive: 'archived' } as const

function listParam<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T[] | undefined {
  if (!value) return undefined
  const isAllowed = (item: string): item is T => allowed.some((candidate) => candidate === item)
  const items = value.split(',').map((item) => item.trim())
  const unknown = items.find((item) => !isAllowed(item))
  if (unknown !== undefined) throw new HTTPException(400, { message: `unknown ${name} ${unknown}` })
  return items.filter(isAllowed)
}

const contentOf = (entry: KnowledgeEntry | undefined) =>
  entry && {
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    scope: entry.scope,
    topics: entry.topics,
    appliesTo: entry.appliesTo,
    packages: entry.packages,
    status: entry.status,
    evidence: entry.evidence,
    supersedes: entry.supersedes,
  }

const audit = (
  c: AppContext,
  action: string,
  before: KnowledgeEntry | undefined,
  after: KnowledgeEntry | undefined,
) =>
  c.set('audit', {
    action,
    target: { type: 'knowledge', id: (after ?? before)?.id ?? '' },
    changes: diffChanges(contentOf(before), contentOf(after)),
    ...(after && { details: { version: after.version } }),
  })

async function readDraft(c: AppContext) {
  const body: unknown = await c.req.json().catch(() => undefined)
  const result = validateEntry(body)
  if (!result.success) throw new HTTPException(400, { message: result.issues[0] ?? 'invalid body' })
  const version =
    typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version)))
    throw new HTTPException(400, { message: 'version: must be an integer' })
  return { draft: result.data, version }
}

/**
 * The knowledge base: decisions, conventions, migrations, quirks and how-tos that agents read and
 * propose and people curate. Permissions are checked against the entry's scope like credentials;
 * listing by repository needs `knowledge:read` on that repository instead.
 */
export function knowledgeRoutes({ store, config, now }: ServerDeps) {
  const app = new Hono<Env>()

  const existing = async (c: AppContext, action: 'knowledge:read' | 'knowledge:write') => {
    const entry = await store.knowledge.get(c.req.param('id') ?? '')
    if (!entry) throw new HTTPException(404, { message: 'knowledge entry not found' })
    const principal = authorize(c, action, scopeTarget(entry.scope))
    return { entry, principal }
  }

  const record = (actor: string, action: string, entry: KnowledgeEntry, details = {}) =>
    store.activity.append({
      at: entry.updatedAt,
      actor,
      action,
      subject: entry.id,
      details: { title: entry.title, kind: entry.kind, scope: entry.scope, ...details },
    })

  app.get('/knowledge', async (c) => {
    const principal = principalOf(c)
    const status = listParam<KnowledgeStatus>(c.req.query('status'), knowledgeStatuses, 'status')
    const kind = listParam<KnowledgeKind>(c.req.query('kind'), knowledgeKinds, 'kind')
    const filter: KnowledgeFilter = {
      ...(status && { status }),
      ...(kind && { kind }),
      ...(c.req.query('topic') && { topic: c.req.query('topic') }),
      ...(c.req.query('package') && { package: c.req.query('package') }),
      ...(c.req.query('scope') && { scope: c.req.query('scope') }),
    }
    const limit = limitParam(c.req.query('limit'))
    const query = c.req.query('q')?.trim()
    const hits: KnowledgeEntryView[] = query
      ? (await store.knowledge.search(query, filter, pool)).map(({ entry, score }) => ({
          ...entry,
          score,
        }))
      : await store.knowledge.list(filter)

    const repo = parseRepo(c.req.query('repo'))
    let visible: KnowledgeEntryView[]
    if (repo) {
      const target = repoTarget(config, repo)
      authorize(c, 'knowledge:read', { kind: 'repo', repo: target })
      visible = hits.filter((entry) => scopeCoversRepo(entry.scope, target))
    } else {
      visible = hits.filter((entry) => can(principal, 'knowledge:read', scopeTarget(entry.scope)))
    }
    return c.json<KnowledgeList>({ entries: visible.slice(0, limit) })
  })

  app.get('/knowledge/:id', async (c) => {
    const { entry } = await existing(c, 'knowledge:read')
    return c.json<KnowledgeDetail>({ entry, history: await store.knowledge.history(entry.id) })
  })

  app.post('/knowledge', async (c) => {
    const { draft } = await readDraft(c)
    const principal = authorize(c, 'knowledge:write', scopeTarget(draft.scope))
    if (draft.supersedes && !(await store.knowledge.get(draft.supersedes)))
      throw new HTTPException(400, { message: 'supersedes: unknown entry' })
    const at = now().toISOString()
    const entry = await store.knowledge.put({
      ...draft,
      id: crypto.randomUUID(),
      status: draft.status ?? 'accepted',
      source: 'human',
      author: principal.id,
      createdAt: at,
      updatedAt: at,
    })
    await record(principal.id, 'knowledge.created', entry, { status: entry.status })
    audit(c, 'knowledge.create', undefined, entry)
    return c.json<KnowledgeEntry>(entry, 201)
  })

  app.put('/knowledge/:id', async (c) => {
    const { entry: previous, principal } = await existing(c, 'knowledge:write')
    const { draft, version } = await readDraft(c)
    authorize(c, 'knowledge:write', scopeTarget(draft.scope))
    if (version !== undefined && version !== previous.version)
      throw new HTTPException(409, {
        message: `entry is at version ${previous.version}, not ${version}`,
      })
    if (draft.supersedes === previous.id)
      throw new HTTPException(400, { message: 'supersedes: an entry cannot supersede itself' })
    const entry = await store.knowledge.put({
      ...draft,
      id: previous.id,
      status: draft.status ?? previous.status,
      source: previous.source,
      author: previous.author,
      createdAt: previous.createdAt,
      updatedAt: now().toISOString(),
      updatedBy: principal.id,
    })
    await record(principal.id, 'knowledge.updated', entry, { version: entry.version })
    audit(c, 'knowledge.update', previous, entry)
    return c.json<KnowledgeEntry>(entry)
  })

  app.post('/knowledge/:id/:action{accept|reject|archive}', async (c) => {
    const { entry: previous, principal } = await existing(c, 'knowledge:write')
    const action = c.req.param('action')
    const status =
      action === 'accept' || action === 'reject' || action === 'archive'
        ? statusFor[action]
        : undefined
    if (!status) throw new HTTPException(404, { message: 'not found' })
    if (previous.status === status) return c.json<KnowledgeEntry>(previous)
    const at = now().toISOString()
    const { version: _version, ...rest } = previous
    const entry = await store.knowledge.put({
      ...rest,
      status,
      updatedAt: at,
      updatedBy: principal.id,
    })
    await record(principal.id, `knowledge.${status}`, entry)
    audit(c, `knowledge.${action}`, previous, entry)

    if (status === 'accepted' && entry.supersedes) {
      const replaced = await store.knowledge.get(entry.supersedes)
      if (
        replaced &&
        replaced.status !== 'archived' &&
        can(principal, 'knowledge:write', scopeTarget(replaced.scope))
      ) {
        const { version: _old, ...replacedRest } = replaced
        const archived = await store.knowledge.put({
          ...replacedRest,
          status: 'archived',
          updatedAt: at,
          updatedBy: principal.id,
        })
        await record(principal.id, 'knowledge.archived', archived, { supersededBy: entry.id })
      }
    }
    return c.json<KnowledgeEntry>(entry)
  })

  app.delete('/knowledge/:id', async (c) => {
    const { entry, principal } = await existing(c, 'knowledge:write')
    await store.knowledge.remove(entry.id)
    audit(c, 'knowledge.delete', entry, undefined)
    await store.activity.append({
      at: now().toISOString(),
      actor: principal.id,
      action: 'knowledge.removed',
      subject: entry.id,
      details: { title: entry.title, kind: entry.kind, scope: entry.scope },
    })
    return c.body(null, 204)
  })

  return app
}
