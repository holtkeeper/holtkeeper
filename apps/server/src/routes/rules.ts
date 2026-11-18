import { type Principal, type Scope, can, scopeCoversRepo, scopeSchema } from '@holtkeeper/access'
import type { EffectiveRules, RuleDetail, RuleList, RuleView } from '@holtkeeper/api'
import {
  type Rule,
  type RuleAgent,
  type RuleContent,
  RuleVersionConflictError,
} from '@holtkeeper/store'
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
import { createRulesResolver } from '../rules.ts'

const scopeTarget = (scope: Scope) => ({ kind: 'scope' as const, scope })

/** A scope that names something: everything, a team or a repository pattern. */
export const ruleScopeSchema = scopeSchema.refine(
  (scope) => scope.all === true || Boolean(scope.teams?.length) || Boolean(scope.repos?.length),
  'scope: name everything, a team or a repository pattern',
)

/** The agent runs a rule or learning may be limited to. */
export const ruleAgentSchema = z.enum(['review', 'task', 'chat', 'release'] satisfies RuleAgent[])

/** Repository-relative path globs of a rule or learning. */
export const globsSchema = z.array(z.string().trim().min(1).max(300)).max(50)

const ruleBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  scope: ruleScopeSchema,
  files: globsSchema.optional(),
  agents: z.array(ruleAgentSchema).optional(),
  description: z.string().trim().max(1000).optional(),
  alwaysApply: z.boolean().optional(),
  version: z.number().int().min(0).optional(),
})

const listQuery = z.object({
  team: z.string().optional(),
  repo: z.string().optional(),
  text: z.string().optional(),
})

const effectiveQuery = z.object({
  repo: z.string(),
  agent: ruleAgentSchema.optional(),
  files: z.string().optional(),
})

const contentOf = (body: z.infer<typeof ruleBodySchema>): RuleContent => ({
  title: body.title,
  body: body.body,
  scope: body.scope,
  ...(body.files?.length && { files: body.files }),
  ...(body.agents?.length && { agents: body.agents }),
  ...(body.description && { description: body.description }),
  ...(body.alwaysApply !== undefined && { alwaysApply: body.alwaysApply }),
})

const audited = (rule: Rule | undefined) =>
  rule && {
    title: rule.title,
    body: rule.body,
    scope: rule.scope,
    files: rule.files,
    agents: rule.agents,
    description: rule.description,
    alwaysApply: rule.alwaysApply,
  }

const audit = (c: AppContext, action: string, before?: Rule, after?: Rule) =>
  c.set('audit', {
    action,
    target: { type: 'rule', id: (after ?? before)?.id ?? '' },
    changes: diffChanges(audited(before), audited(after)),
    ...(after && { details: { version: after.version } }),
  })

const view = (principal: Principal, rule: Rule): RuleView => ({
  ...rule,
  canEdit: can(principal, 'knowledge:write', scopeTarget(rule.scope)),
})

/** Whether the principal holds `knowledge:write` anywhere, so the panel offers a new rule. */
const writesSomewhere = (principal: Principal) =>
  principal.grants.some((grant) =>
    grant.actions.some((action) => action === '*' || action === 'knowledge:write'),
  )

/**
 * Panel rules (`/api/rules`) and the effective rules of a repository (`/api/rules/effective`).
 * Rules are checked against their scope: reading needs `knowledge:read` over it, writing
 * `knowledge:write` (on both the old and the new scope when an edit moves it). The effective view
 * needs `knowledge:read` on the repository and goes through the same resolver agent runs use.
 */
export function ruleRoutes(deps: ServerDeps) {
  const { store, config, now } = deps
  const app = new Hono<Env>()
  const resolve = createRulesResolver({ store, config, now })

  const existing = async (c: AppContext, action: 'knowledge:read' | 'knowledge:write') => {
    const rule = await store.rules.get(c.req.param('id') ?? '')
    const principal = principalOf(c)
    if (!rule) throw new HTTPException(404, { message: 'rule not found' })
    if (
      !can(principal, 'knowledge:read', scopeTarget(rule.scope)) ||
      !can(principal, action, scopeTarget(rule.scope))
    )
      throw new ForbiddenException(action)
    return { rule, principal }
  }

  app.get('/rules', async (c) => {
    const principal = principalOf(c)
    const query = readQuery(c, listQuery)
    const repo = query.repo ? parseRepo(query.repo) : undefined
    const target = repo && repoTarget(config, repo)
    const text = query.text?.trim()
    const found = text
      ? (await store.rules.search(text, 200)).map((hit) => hit.rule)
      : await store.rules.list()
    const rules = found.filter(
      (rule) =>
        can(principal, 'knowledge:read', scopeTarget(rule.scope)) &&
        (!query.team ||
          rule.scope.all === true ||
          Boolean(rule.scope.teams?.includes(query.team))) &&
        (!target || scopeCoversRepo(rule.scope, target)),
    )
    return c.json<RuleList>({
      rules: rules.map((rule) => view(principal, rule)),
      canCreate: writesSomewhere(principal),
    })
  })

  app.get('/rules/effective', async (c) => {
    const query = readQuery(c, effectiveQuery)
    const repo = parseRepo(query.repo)
    if (!repo) throw new HTTPException(400, { message: 'repo must look like <forge>:<path>' })
    const target = repoTarget(config, repo)
    authorize(c, 'knowledge:read', { kind: 'repo', repo: target })
    const agent = query.agent ?? 'review'
    const files = query.files
      ?.split(',')
      .map((file) => file.trim())
      .filter(Boolean)
    const resolved = await resolve({ repo: target, agent, ...(files?.length && { files }) })
    return c.json<EffectiveRules>({ ...resolved, repo: query.repo, agent })
  })

  app.get('/rules/:id', async (c) => {
    const { rule, principal } = await existing(c, 'knowledge:read')
    return c.json<RuleDetail>({
      rule: view(principal, rule),
      history: await store.rules.history(rule.id),
    })
  })

  app.post('/rules', async (c) => {
    const body = await readBody(c, ruleBodySchema)
    const content = contentOf(body)
    const principal = authorize(c, 'knowledge:write', scopeTarget(content.scope))
    const at = now().toISOString()
    const rule = await store.rules.put(
      { ...content, id: crypto.randomUUID(), author: principal.id, createdAt: at, updatedAt: at },
      0,
    )
    audit(c, 'rule.create', undefined, rule)
    return c.json<RuleView>(view(principal, rule), 201)
  })

  app.put('/rules/:id', async (c) => {
    const { rule: before, principal } = await existing(c, 'knowledge:write')
    const body = await readBody(c, ruleBodySchema)
    const content = contentOf(body)
    authorize(c, 'knowledge:write', scopeTarget(content.scope))
    try {
      const rule = await store.rules.put(
        {
          ...content,
          id: before.id,
          author: before.author,
          createdAt: before.createdAt,
          updatedAt: now().toISOString(),
          updatedBy: principal.id,
        },
        body.version,
      )
      audit(c, 'rule.update', before, rule)
      return c.json<RuleView>(view(principal, rule))
    } catch (error) {
      if (error instanceof RuleVersionConflictError)
        throw new HTTPException(409, {
          message: `the rule changed since you opened it (now version ${error.stored})`,
        })
      throw error
    }
  })

  app.delete('/rules/:id', async (c) => {
    const { rule } = await existing(c, 'knowledge:write')
    await store.rules.remove(rule.id)
    audit(c, 'rule.delete', rule, undefined)
    return c.body(null, 204)
  })

  return app
}
