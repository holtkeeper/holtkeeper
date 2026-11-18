import { type Principal, type Scope, can, scopeCoversRepo } from '@holtkeeper/access'
import type {
  LearningCreateResult,
  LearningList,
  LearningView,
  ReactionTotalsList,
} from '@holtkeeper/api'
import { decideLearning, learningKey, settleLearning } from '@holtkeeper/rules'
import type { Learning, LearningOrigin, LearningStatus, SettingEntry } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { diffChanges } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  ForbiddenException,
  authorize,
  parseRepo,
  principalOf,
  readBody,
  readQuery,
  repoTarget,
} from '../context.ts'
import { addLearning } from '../learnings.ts'
import { policyOfLearning } from '../rules.ts'
import { peopleOf } from './avatars.ts'
import { globsSchema, ruleAgentSchema, ruleScopeSchema } from './rules.ts'

const DAY = 24 * 3600 * 1000

const scopeTarget = (scope: Scope) => ({ kind: 'scope' as const, scope })

const statuses = ['pending', 'active', 'rejected', 'expired'] as const satisfies LearningStatus[]
const origins = ['reply', 'miner', 'agent', 'person'] as const satisfies LearningOrigin[]

const textSchema = z.string().trim().min(1).max(300)

const listQuery = z.object({
  status: z.string().optional(),
  origin: z.string().optional(),
  repo: z.string().optional(),
  text: z.string().optional(),
})

const createSchema = z.object({
  text: textSchema,
  reason: z.string().trim().max(1000).optional(),
  scope: ruleScopeSchema,
  files: globsSchema.optional(),
  agents: z.array(ruleAgentSchema).optional(),
})

const patchSchema = z.object({
  text: textSchema.optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
  scope: ruleScopeSchema.optional(),
  files: globsSchema.nullable().optional(),
  agents: z.array(ruleAgentSchema).nullable().optional(),
})

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

const audited = (learning: Learning | undefined) =>
  learning && {
    text: learning.text,
    reason: learning.reason,
    scope: learning.scope,
    files: learning.files,
    agents: learning.agents,
    status: learning.status,
  }

const audit = (c: AppContext, action: string, before?: Learning, after?: Learning) =>
  c.set('audit', {
    action,
    target: { type: 'learning', id: (after ?? before)?.id ?? '' },
    changes: diffChanges(audited(before), audited(after)),
  })

/**
 * Learnings: the short rules Holtkeeper learned from review replies, merged merge requests and
 * agents, and the ones people write. Each is checked against its scope: reading needs
 * `knowledge:read` over it, approving, rejecting, editing and deleting `knowledge:write` (on the
 * old and the new scope when an edit moves it). Lists show the status brought up to now
 * (`settleLearning`), so a learning past its approval delay reads `active` before the leader tick
 * stores it. `GET /learnings/reactions` sums 👍/👎 on review comments per finding category.
 */
export function learningRoutes(deps: ServerDeps) {
  const { store, config, now } = deps
  const app = new Hono<Env>()

  const settled = (learning: Learning, entries: readonly SettingEntry[]) =>
    settleLearning(learning, now().toISOString(), policyOfLearning(config, entries, learning))

  const view = (
    principal: Principal,
    learning: Learning,
    entries: readonly SettingEntry[],
  ): LearningView => {
    const expiryDays = policyOfLearning(config, entries, learning).expiryDays
    return {
      ...learning,
      canEdit: can(principal, 'knowledge:write', scopeTarget(learning.scope)),
      ...(learning.status === 'active' && {
        expiresAt: new Date(Date.parse(learning.lastReinforcedAt) + expiryDays * DAY).toISOString(),
      }),
    }
  }

  const existing = async (c: AppContext) => {
    const [stored, entries] = await Promise.all([
      store.learnings.get(c.req.param('id') ?? ''),
      store.settings.list(),
    ])
    const principal = principalOf(c)
    if (!stored) throw new HTTPException(404, { message: 'learning not found' })
    if (
      !can(principal, 'knowledge:read', scopeTarget(stored.scope)) ||
      !can(principal, 'knowledge:write', scopeTarget(stored.scope))
    )
      throw new ForbiddenException('knowledge:write')
    return { learning: settled(stored, entries), stored, principal, entries }
  }

  app.get('/learnings', async (c) => {
    const principal = principalOf(c)
    const query = readQuery(c, listQuery)
    const status = listParam(query.status, statuses, 'status')
    const origin = listParam(query.origin, origins, 'origin')
    const repo = query.repo ? parseRepo(query.repo) : undefined
    const target = repo && repoTarget(config, repo)
    const text = query.text?.trim()
    const filter = { ...(origin && { origin }) }
    const [found, entries] = await Promise.all([
      text
        ? store.learnings.search(text, filter, 200).then((hits) => hits.map((hit) => hit.learning))
        : store.learnings.list(filter),
      store.settings.list(),
    ])
    const learnings = found
      .map((learning) => settled(learning, entries))
      .filter(
        (learning) =>
          (!status || status.includes(learning.status)) &&
          can(principal, 'knowledge:read', scopeTarget(learning.scope)) &&
          (!target || scopeCoversRepo(learning.scope, target)),
      )
      .map((learning) => view(principal, learning, entries))
    return c.json<LearningList>({
      learnings,
      people: await peopleOf(
        deps,
        learnings.flatMap((learning) => [
          ...(learning.decidedBy ? [learning.decidedBy] : []),
          ...(learning.editedBy ? [learning.editedBy] : []),
        ]),
      ),
    })
  })

  app.get('/learnings/reactions', async (c) => {
    const principal = principalOf(c)
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) {
      if (!can(principal, 'knowledge:read', { kind: 'global' }))
        throw new HTTPException(400, {
          message: 'repo is required without a global knowledge:read grant',
        })
      return c.json<ReactionTotalsList>({ totals: await store.learnings.reactionTotals() })
    }
    const target = repoTarget(config, repo)
    if (!can(principal, 'knowledge:read', { kind: 'repo', repo: target }))
      throw new ForbiddenException('knowledge:read', c.req.query('repo'))
    const totals = await store.learnings.reactionTotals({ repos: [`${repo.forge}:${repo.path}`] })
    return c.json<ReactionTotalsList>({ totals })
  })

  app.post('/learnings', async (c) => {
    const body = await readBody(c, createSchema)
    const principal = authorize(c, 'knowledge:write', scopeTarget(body.scope))
    const outcome = await addLearning(
      deps,
      {
        text: body.text,
        ...(body.reason && { reason: body.reason }),
        scope: body.scope,
        ...(body.files?.length && { files: body.files }),
        ...(body.agents?.length && { agents: body.agents }),
        origin: 'person',
        source: { author: principal.id, at: now().toISOString() },
      },
      { approvedBy: principal.id },
    )
    audit(
      c,
      outcome.status === 'added' ? 'learning.create' : 'learning.reinforce',
      undefined,
      outcome.learning,
    )
    const entries = await store.settings.list()
    return c.json<LearningCreateResult>(
      { status: outcome.status, learning: view(principal, outcome.learning, entries) },
      outcome.status === 'added' ? 201 : 200,
    )
  })

  app.patch('/learnings/:id', async (c) => {
    const { learning, principal, entries } = await existing(c)
    const patch = await readBody(c, patchSchema)
    if (patch.scope) authorize(c, 'knowledge:write', scopeTarget(patch.scope))
    const { reason: _reason, files: _files, agents: _agents, ...rest } = learning
    const text = patch.text ?? learning.text
    const reason = patch.reason === undefined ? learning.reason : (patch.reason ?? undefined)
    const files = patch.files === undefined ? learning.files : (patch.files ?? undefined)
    const agents = patch.agents === undefined ? learning.agents : (patch.agents ?? undefined)
    const at = now().toISOString()
    const updated: Learning = {
      ...rest,
      text,
      key: learningKey(text),
      ...(reason && { reason }),
      ...(patch.scope && { scope: patch.scope }),
      ...(files?.length && { files }),
      ...(agents?.length && { agents }),
      editedBy: principal.id,
      updatedAt: at,
    }
    const clash = updated.key !== learning.key && (await store.learnings.find(updated.key))
    if (clash && clash.id !== learning.id)
      throw new HTTPException(409, { message: `another learning already says this (${clash.id})` })
    await store.learnings.put(updated)
    audit(c, 'learning.update', learning, updated)
    return c.json<LearningView>(view(principal, updated, entries))
  })

  const decide = (decision: 'approve' | 'reject') => async (c: AppContext) => {
    const { learning, principal, entries } = await existing(c)
    if (decision === 'approve' && learning.status === 'active')
      throw new HTTPException(409, { message: 'the learning is already active' })
    if (decision === 'reject' && learning.status === 'rejected')
      throw new HTTPException(409, { message: 'the learning is already rejected' })
    const decided = decideLearning(learning, decision, principal.id, now().toISOString())
    await store.learnings.put(decided)
    audit(c, `learning.${decision}`, learning, decided)
    return c.json<LearningView>(view(principal, decided, entries))
  }

  app.post('/learnings/:id/approve', decide('approve'))
  app.post('/learnings/:id/reject', decide('reject'))

  app.delete('/learnings/:id', async (c) => {
    const { stored } = await existing(c)
    await store.learnings.remove(stored.id)
    audit(c, 'learning.delete', stored, undefined)
    return c.body(null, 204)
  })

  return app
}
