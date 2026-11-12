import { type Principal, can } from '@holtkeeper/access'
import type {
  AcceptLearningsResult,
  LearningCandidateView,
  LearningList,
  ReactionTotalsList,
} from '@holtkeeper/api'
import {
  LEARNING_RULE_MAX,
  LearningConflictError,
  LearningScopeError,
  acceptLearning,
  defaultLearningScope,
  editLearning,
  familyOf,
  guideScopeKey,
  guideSections,
  parseGuideScope,
  rejectLearning,
  scopesFor,
} from '@holtkeeper/guide'
import type { Family, GuideScopeKey, LearningCandidate, LearningStatus } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { appendAudit, auditActorOf, diffChanges, viaOf } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorizeRecord,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
  ForbiddenException,
  repoKey,
} from '../context.ts'
import { learningConfidence, learningSourceKind, withLiveTarget } from '../learnings.ts'
import { peopleOf } from './avatars.ts'
import { editAction, guideScopePermission } from './guides.ts'

const statuses = ['proposed', 'accepted', 'rejected'] as const satisfies LearningStatus[]

const ruleSchema = z.string().trim().min(1).max(LEARNING_RULE_MAX)

const editSchema = z.object({
  rule: ruleSchema.optional(),
  section: z.enum(guideSections).optional(),
  suggestedScope: z.enum(['repo', 'family', 'group']).optional(),
  targetScope: z.string().min(1).optional(),
})

const acceptSchema = z.object({
  scope: z.string().min(1).optional(),
  rule: ruleSchema.optional(),
  section: z.enum(guideSections).optional(),
})

const batchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  scope: z.string().min(1).optional(),
})

const decided = (candidate: LearningCandidate) => ({
  rule: candidate.rule,
  section: candidate.section,
  status: candidate.status,
  suggested: candidate.suggestedScope,
  ...(candidate.targetScope && { target: candidate.targetScope }),
  ...(candidate.acceptedScope && { scope: candidate.acceptedScope }),
})

const auditOf = (action: string, before: LearningCandidate, after: LearningCandidate) => ({
  action,
  target: { type: 'learning', id: after.id, repo: after.repo },
  changes: diffChanges(decided(before), decided(after)),
})

const audit = (
  c: AppContext,
  action: string,
  before: LearningCandidate,
  after: LearningCandidate,
) => c.set('audit', auditOf(action, before, after))

const saving = async (work: () => Promise<LearningCandidate>) => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof LearningConflictError)
      throw new HTTPException(409, { message: error.message })
    if (error instanceof LearningScopeError)
      throw new HTTPException(400, { message: error.message })
    throw error
  }
}

/**
 * Learning candidates from replies to review comments and the reactions on those comments.
 * Reading needs `knowledge:read` on the candidate's repository (reaction totals without `repo`
 * need it globally); accepting, editing and rejecting
 * need `knowledge:write` on it, plus edit rights (`editAction`) on the scope the rule goes to or
 * leaves. A candidate may be accepted into any scope that applies to its repository; without a
 * scope it goes to its `targetScope`, else where `suggestedScope` points. `PATCH` may set a
 * `targetScope` among the repository's scopes that the caller may edit.
 * `POST /learnings/accept` accepts several with the same checks per candidate; each accepted one
 * gets its own `learning.accept` audit event, and the request itself is audited as
 * `learnings.accept`.
 */
export function learningRoutes(deps: ServerDeps) {
  const { store, config, now } = deps
  const app = new Hono<Env>()
  const permitted = guideScopePermission(config)

  const targetOf = (candidate: LearningCandidate) => {
    const repo = parseRepo(candidate.repo)
    if (!repo) throw new HTTPException(500, { message: 'candidate has no repository' })
    return repoTarget(config, repo)
  }

  const scopeAllowed = (principal: Principal, key: GuideScopeKey, family?: Family) => {
    const scope = parseGuideScope(key)
    return scope !== undefined && permitted(principal, editAction(scope), scope, family)
  }

  const contextOf = async (candidate: LearningCandidate) => {
    const target = targetOf(candidate)
    const family = familyOf(await store.families.list(), candidate.repo)
    return { target, family, scopes: scopesFor(target, family?.id) }
  }

  const load = async (c: AppContext, action: string) => {
    const candidate = await store.learnings.get(c.req.param('id') ?? '')
    if (!candidate) throw new HTTPException(404, { message: 'learning candidate not found' })
    c.set('audit', { action, target: { type: 'learning', id: candidate.id } })
    const context = await contextOf(candidate)
    const principal = authorizeRecord(c, 'knowledge:write', { kind: 'repo', repo: context.target })
    return { candidate, principal, ...context }
  }

  const ensureScope = (
    principal: Principal,
    key: GuideScopeKey,
    family?: Family,
    stored = false,
  ) => {
    if (!scopeAllowed(principal, key, family)) {
      const scope = parseGuideScope(key)
      throw new ForbiddenException(
        'knowledge:write',
        !stored && scope?.kind === 'repo' ? repoKey(scope) : undefined,
        stored
          ? 'missing permission to edit the scope this rule lives in'
          : `missing permission to edit ${key}`,
      )
    }
  }

  const ensurePlaced = async (principal: Principal, candidate: LearningCandidate) => {
    if (candidate.status !== 'accepted' || !candidate.acceptedScope) return
    const scope = parseGuideScope(candidate.acceptedScope)
    const family = scope?.kind === 'family' ? await store.families.get(scope.family) : undefined
    ensureScope(principal, candidate.acceptedScope, family, true)
  }

  app.get('/learnings', async (c) => {
    const principal = principalOf(c)
    const repo = parseRepo(c.req.query('repo'))
    const wanted = (c.req.query('status') ?? '').split(',').filter(Boolean)
    const status = wanted.filter((value): value is LearningStatus =>
      statuses.some((known) => known === value),
    )
    if (status.length !== wanted.length)
      throw new HTTPException(400, { message: `status must be among ${statuses.join(', ')}` })
    const families = await store.families.list()
    const candidates = await store.learnings.list({
      ...(repo && { repos: [`${repo.forge}:${repo.path}`] }),
      ...(status.length && { status }),
    })
    const views = candidates.flatMap((candidate): LearningCandidateView[] => {
      const target = targetOf(candidate)
      if (!can(principal, 'knowledge:read', { kind: 'repo', repo: target })) return []
      const family = familyOf(families, candidate.repo)
      const canDecide = can(principal, 'knowledge:write', { kind: 'repo', repo: target })
      const scopes = scopesFor(target, family?.id)
      return [
        {
          ...withLiveTarget(candidate, scopes),
          sourceKind: learningSourceKind(candidate),
          confidence: learningConfidence(candidate),
          canDecide,
          scopes: canDecide ? scopes.filter((key) => scopeAllowed(principal, key, family)) : [],
        },
      ]
    })
    return c.json<LearningList>({
      candidates: views,
      people: await peopleOf(
        deps,
        views.flatMap((view) => [
          ...(view.decidedBy ? [view.decidedBy] : []),
          ...(view.editedBy ? [view.editedBy] : []),
          ...(view.proposal ? [view.proposal.by] : []),
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

  const accept = async (
    principal: Principal,
    candidate: LearningCandidate,
    input: z.infer<typeof acceptSchema>,
  ) => {
    const { family, scopes } = await contextOf(candidate)
    const chosen = input.scope === undefined ? undefined : parseGuideScope(input.scope)
    if (input.scope !== undefined && !chosen)
      throw new HTTPException(400, { message: 'scope must be all, group:, family: or repo:' })
    const scope = chosen ? guideScopeKey(chosen) : defaultLearningScope(candidate, scopes)
    if (!scope)
      throw new HTTPException(400, {
        message: `the repository has no ${candidate.suggestedScope}; choose a scope`,
      })
    if (!scopes.some((key) => key === scope))
      throw new HTTPException(400, { message: `${scope} does not apply to ${candidate.repo}` })
    ensureScope(principal, scope, family)
    await ensurePlaced(principal, candidate)
    return saving(() =>
      acceptLearning(store, candidate, {
        scope,
        ...(input.rule && { rule: input.rule }),
        ...(input.section && { section: input.section }),
        by: principal.id,
        at: now().toISOString(),
      }),
    )
  }

  const acceptOneOf = async (
    c: AppContext,
    principal: Principal,
    id: string,
    scope: string | undefined,
  ): Promise<string | undefined> => {
    const candidate = await store.learnings.get(id)
    const target = candidate && targetOf(candidate)
    if (!candidate || !target || !can(principal, 'knowledge:read', { kind: 'repo', repo: target }))
      return 'learning candidate not found'
    if (!can(principal, 'knowledge:write', { kind: 'repo', repo: target }))
      return 'missing permission knowledge:write'
    try {
      const stored = await accept(principal, candidate, scope === undefined ? {} : { scope })
      await appendAudit(store, {
        at: now().toISOString(),
        actor: auditActorOf(principal, deps.auth.name),
        via: viaOf(c, c.req.path),
        ...auditOf('learning.accept', candidate, stored),
        outcome: 'ok',
        details: { batch: true },
      })
      return undefined
    } catch (error) {
      if (error instanceof HTTPException) return error.message
      throw error
    }
  }

  app.post('/learnings/accept', async (c) => {
    const principal = principalOf(c)
    const input = await readBody(c, batchSchema)
    const result: AcceptLearningsResult = { accepted: [], failed: [] }
    for (const id of new Set(input.ids)) {
      // oxlint-disable-next-line no-await-in-loop -- one Guide write after another keeps section versions apart
      const outcome = await acceptOneOf(c, principal, id, input.scope)
      if (outcome === undefined) result.accepted.push(id)
      else result.failed.push({ id, error: outcome })
    }
    c.set('audit', {
      action: 'learnings.accept',
      target: { type: 'learning' },
      details: { accepted: result.accepted.length, failed: result.failed.length },
    })
    return c.json<AcceptLearningsResult>(result)
  })

  app.post('/learnings/:id/accept', async (c) => {
    const { candidate, principal } = await load(c, 'learning.accept')
    const input = await readBody(c, acceptSchema)
    const stored = await accept(principal, candidate, input)
    audit(c, 'learning.accept', candidate, stored)
    return c.json<LearningCandidate>(stored)
  })

  app.post('/learnings/:id/reject', async (c) => {
    const { candidate, principal } = await load(c, 'learning.reject')
    await ensurePlaced(principal, candidate)
    const stored = await rejectLearning(store, candidate, {
      by: principal.id,
      at: now().toISOString(),
    })
    audit(c, 'learning.reject', candidate, stored)
    return c.json<LearningCandidate>(stored)
  })

  app.patch('/learnings/:id', async (c) => {
    const { candidate, principal, scopes, family } = await load(c, 'learning.update')
    const input = await readBody(c, editSchema)
    const target = input.targetScope === undefined ? undefined : parseGuideScope(input.targetScope)
    const key = target && target.kind !== 'all' ? guideScopeKey(target) : undefined
    if (input.targetScope !== undefined && (!key || !scopes.includes(key)))
      throw new HTTPException(400, {
        message: `${input.targetScope} is not a group, family or repository scope of ${candidate.repo}`,
      })
    await ensurePlaced(principal, candidate)
    if (key) ensureScope(principal, key, family)
    const stored = await saving(() =>
      editLearning(store, candidate, {
        ...(input.rule && { rule: input.rule }),
        ...(input.section && { section: input.section }),
        ...(input.suggestedScope && { suggestedScope: input.suggestedScope }),
        ...(key && { targetScope: key }),
        by: principal.id,
        at: now().toISOString(),
      }),
    )
    audit(c, 'learning.update', candidate, stored)
    return c.json<LearningCandidate>(stored)
  })

  return app
}
