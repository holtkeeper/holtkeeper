import { type Action, type Principal, type RepoTarget, can } from '@holtkeeper/access'
import type {
  FamilyList,
  FamilySuggestionList,
  GuidePreview,
  GuideScopeView,
  GuideSectionDetail,
  Job,
} from '@holtkeeper/api'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import {
  type GuideScope,
  type RepoSignals,
  createGuideResolver,
  guideScopeKey,
  guideSections,
  guideTasks,
  isGuideSection,
  isGuideTask,
  parseGuideScope,
  repoKey,
  suggestFamilies,
  suggestionKey,
} from '@holtkeeper/guide'
import { generatedSections, pendingGenerated } from '@holtkeeper/guide-generator'
import {
  type AnalysisStore,
  type Family,
  FamilyConflictError,
  type GuideScopeKey,
  type GuideSection,
  type GuideSectionName,
  newestRecords,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { createUsageIndex } from '../api-surface/usages.ts'
import { diffChanges } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { peopleOf } from './avatars.ts'

const putSectionSchema = z.object({
  rules: z.string().max(50_000),
  steering: z.string().max(2_000).optional(),
  version: z.number().int().min(0).optional(),
})

const acceptSchema = z.object({ inputHash: z.string().min(1).optional() })

const regenerateSchema = z.object({
  sections: z.array(z.enum(generatedSections)).min(1).optional(),
  prompt: z.string().trim().max(2_000).optional(),
})

const familySchema = z.object({
  name: z.string().trim().min(1).max(80),
  members: z
    .array(z.string().regex(/^[^:\s]+:\S+$/, 'members are forge:path'))
    .min(2)
    .max(200)
    .refine((members) => new Set(members).size === members.length, 'members must be unique'),
})

const dismissSchema = z.object({ members: familySchema.shape.members })

/** `Store.kv` key of the dismissed family suggestions, a list of `suggestionKey`s. */
const DISMISSED_KEY = 'families:dismissed-suggestions'

const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []

const emptySection = (scope: GuideScopeKey, section: GuideSectionName): GuideSection => ({
  scope,
  section,
  rules: '',
  steering: '',
  version: 0,
  learnings: [],
})

const human = (section: GuideSection | undefined) =>
  section && { rules: section.rules, steering: section.steering }

interface StackShape {
  components?: { kind?: unknown; id?: unknown; usages?: { repo?: unknown }[] }[]
}

/** Runtimes and package managers per `forge:path`, from the newest `stack` records. */
async function toolchains(analyses: AnalysisStore): Promise<Map<string, string[]>> {
  const found = await newestRecords(analyses, 'stack', (record) =>
    typeof record.data === 'object' && record.data !== null
      ? (record.data as StackShape)
      : undefined,
  )
  const result = new Map<string, Set<string>>()
  for (const { record, value } of found.values())
    for (const component of value.components ?? []) {
      if (component.kind !== 'runtime' && component.kind !== 'package-manager') continue
      if (typeof component.id !== 'string') continue
      for (const usage of component.usages ?? []) {
        if (typeof usage.repo !== 'string') continue
        const key = `${record.repo.forge}:${usage.repo}`
        result.set(key, (result.get(key) ?? new Set()).add(component.id))
      }
    }
  return new Map([...result].map(([key, ids]) => [key, [...ids]]))
}

/** What editing a scope's sections needs: `knowledge:write` for a repository, else `settings:write`. */
export const editAction = (scope: GuideScope): Action =>
  scope.kind === 'repo' ? 'knowledge:write' : 'settings:write'

/**
 * Whether `principal` may perform `action` on a Guide scope: on `all` reading needs the action in
 * any grant and anything else a global grant; a group needs it on the group, a family on every
 * member, a repository on the repository.
 */
export function guideScopePermission(config: HoltkeeperConfig) {
  const targetOf = (key: string): RepoTarget | undefined => {
    const repo = parseRepo(key)
    return repo && repoTarget(config, repo)
  }
  return (principal: Principal, action: Action, scope: GuideScope, family?: Family): boolean => {
    if (scope.kind === 'all')
      return action === 'knowledge:read'
        ? principal.grants.some(
            (grant) => grant.actions.includes('*') || grant.actions.includes(action),
          )
        : can(principal, action, { kind: 'global' })
    if (scope.kind === 'group')
      return can(principal, action, { kind: 'scope', scope: { groups: [scope.group] } })
    if (scope.kind === 'family')
      return (
        family !== undefined &&
        family.id === scope.family &&
        family.members.length > 0 &&
        family.members.every((member) => {
          const repo = targetOf(member)
          return repo !== undefined && can(principal, action, { kind: 'repo', repo })
        })
      )
    return can(principal, action, {
      kind: 'repo',
      repo: repoTarget(config, { forge: scope.forge, path: scope.path }),
    })
  }
}

const sectionParam = (c: AppContext): GuideSectionName => {
  const section = c.req.query('section')
  if (!isGuideSection(section))
    throw new HTTPException(400, {
      message: `section must be one of ${guideSections.join(', ')}`,
    })
  return section
}

const ensure = (ok: boolean, action: Action) => {
  if (!ok) throw new HTTPException(403, { message: `missing permission ${action}` })
}

const labelOf = (scope: GuideScope, family?: Family) =>
  scope.kind === 'all'
    ? 'All repositories'
    : scope.kind === 'group'
      ? `Team ${scope.group}`
      : scope.kind === 'family'
        ? `Family ${family?.name ?? scope.family}`
        : `${scope.forge}:${scope.path}`

const auditTarget = (scope: GuideScope, key: GuideScopeKey, section: GuideSectionName) => ({
  type: 'guide',
  id: `${key}/${section}`,
  ...(scope.kind === 'repo' && { repo: repoKey(scope) }),
})

const auditEdit = (
  c: AppContext,
  action: string,
  scope: GuideScope,
  key: GuideScopeKey,
  section: GuideSectionName,
  before: GuideSection | undefined,
  after: GuideSection,
) =>
  c.set('audit', {
    action,
    target: auditTarget(scope, key, section),
    changes: diffChanges(human(before), human(after)),
    details: { version: after.version },
  })

/**
 * The Guide: team rules per scope (`all`, group, family, repository) and section, their revisions,
 * the effective prompt of a repository, and families with suggestions. Reading needs
 * `knowledge:read` on the scope; editing `all`, a group or a family needs `settings:write` on it
 * (for a family: on every member), editing a repository's rules `knowledge:write` on it.
 * Accepting a repository's generated text needs `knowledge:write`; regenerating it (a `guide` job)
 * also `analyses:run`.
 */
export function guideRoutes(deps: ServerDeps) {
  const { store, config, now, analyzers } = deps
  const app = new Hono<Env>()
  const resolve = createGuideResolver({ store })
  const usages = createUsageIndex({ analyses: store.analyses })

  const targetOf = (key: string): RepoTarget | undefined => {
    const repo = parseRepo(key)
    return repo && repoTarget(config, repo)
  }

  const permitted = guideScopePermission(config)

  const scopeParam = async (c: AppContext) => {
    const key = c.req.query('scope') ?? ''
    const scope = parseGuideScope(key)
    if (!scope)
      throw new HTTPException(400, { message: 'scope must be all, group:, family: or repo:' })
    if (scope.kind === 'group' && !config.groups[scope.group])
      throw new HTTPException(404, { message: `group ${scope.group} is not configured` })
    if (scope.kind === 'repo' && !config.forges[scope.forge])
      throw new HTTPException(404, { message: `forge ${scope.forge} is not configured` })
    const family = scope.kind === 'family' ? await store.families.get(scope.family) : undefined
    if (scope.kind === 'family' && !family)
      throw new HTTPException(404, { message: 'family not found' })
    return { scope, key: guideScopeKey(scope), family }
  }

  app.get('/guide', async (c) => {
    const principal = principalOf(c)
    const { scope, key, family } = await scopeParam(c)
    ensure(permitted(principal, 'knowledge:read', scope, family), 'knowledge:read')
    const stored = new Map((await store.guides.list({ scopes: [key] })).map((s) => [s.section, s]))
    const sections = guideSections.map(
      (section) => stored.get(section) ?? emptySection(key, section),
    )
    return c.json<GuideScopeView>({
      scope: key,
      label: labelOf(scope, family),
      sections,
      canEdit: permitted(principal, editAction(scope), scope, family),
      people: await peopleOf(
        deps,
        sections.flatMap((s) => [
          ...(s.editedBy ? [s.editedBy] : []),
          ...(s.generated?.acceptedBy ? [s.generated.acceptedBy] : []),
          ...s.learnings.map((learning) => learning.acceptedBy),
        ]),
      ),
    })
  })

  app.get('/guide/section', async (c) => {
    const principal = principalOf(c)
    const { scope, key, family } = await scopeParam(c)
    const section = sectionParam(c)
    ensure(permitted(principal, 'knowledge:read', scope, family), 'knowledge:read')
    const stored = (await store.guides.get(key, section)) ?? emptySection(key, section)
    const history = await store.guides.history(key, section)
    return c.json<GuideSectionDetail>({
      section: stored,
      history,
      canEdit: permitted(principal, editAction(scope), scope, family),
      people: await peopleOf(deps, [
        ...(stored.editedBy ? [stored.editedBy] : []),
        ...history.map((revision) => revision.editedBy),
      ]),
    })
  })

  app.put('/guide/section', async (c) => {
    const principal = principalOf(c)
    const { scope, key, family } = await scopeParam(c)
    const section = sectionParam(c)
    c.set('audit', { action: 'guide.update', target: { type: 'guide', id: `${key}/${section}` } })
    const action = editAction(scope)
    ensure(permitted(principal, action, scope, family), action)
    c.set('audit', { action: 'guide.update', target: auditTarget(scope, key, section) })
    const input = await readBody(c, putSectionSchema)
    const previous = await store.guides.get(key, section)
    if (input.version !== undefined && input.version !== (previous?.version ?? 0))
      throw new HTTPException(409, {
        message: `section is at version ${previous?.version ?? 0}, not ${input.version}`,
      })
    const stored = await store.guides.put({
      ...(previous ?? emptySection(key, section)),
      rules: input.rules.trim(),
      steering: (input.steering ?? previous?.steering ?? '').trim(),
      editedBy: principal.id,
      editedAt: now().toISOString(),
    })
    auditEdit(c, 'guide.update', scope, key, section, previous, stored)
    return c.json<GuideSection>(stored)
  })

  app.post('/guide/section/restore', async (c) => {
    const principal = principalOf(c)
    const { scope, key, family } = await scopeParam(c)
    const section = sectionParam(c)
    c.set('audit', { action: 'guide.restore', target: { type: 'guide', id: `${key}/${section}` } })
    const action = editAction(scope)
    ensure(permitted(principal, action, scope, family), action)
    c.set('audit', { action: 'guide.restore', target: auditTarget(scope, key, section) })
    const version = Number(c.req.query('version'))
    const revision = (await store.guides.history(key, section)).find((r) => r.version === version)
    if (!revision) throw new HTTPException(404, { message: 'revision not found' })
    const previous = await store.guides.get(key, section)
    const stored = await store.guides.put({
      ...(previous ?? emptySection(key, section)),
      rules: revision.rules,
      steering: revision.steering,
      editedBy: principal.id,
      editedAt: now().toISOString(),
    })
    auditEdit(c, 'guide.restore', scope, key, section, previous, stored)
    return c.json<GuideSection>(stored)
  })

  app.post('/guide/section/accept', async (c) => {
    const { scope, key } = await scopeParam(c)
    const section = sectionParam(c)
    c.set('audit', { action: 'guide.accept', target: { type: 'guide', id: `${key}/${section}` } })
    if (scope.kind !== 'repo')
      throw new HTTPException(400, { message: 'only repository scopes have generated text' })
    const principal = authorize(c, 'knowledge:write', {
      kind: 'repo',
      repo: repoTarget(config, { forge: scope.forge, path: scope.path }),
    })
    c.set('audit', { action: 'guide.accept', target: auditTarget(scope, key, section) })
    const input = await readBody(c, acceptSchema)
    const previous = await store.guides.get(key, section)
    const pending = pendingGenerated(previous)
    if (!previous || !pending)
      throw new HTTPException(409, { message: 'no generated text waits for acceptance' })
    if (!pending.body.trim())
      throw new HTTPException(409, { message: 'the generated text is empty; regenerate it first' })
    if (input.inputHash !== undefined && input.inputHash !== pending.inputHash)
      throw new HTTPException(409, { message: 'the proposal changed; reload it before accepting' })
    const { proposal: _, ...row } = previous
    const stored = await store.guides.put({
      ...row,
      generated: {
        ...pending,
        status: 'accepted',
        acceptedBy: principal.id,
        acceptedAt: now().toISOString(),
      },
    })
    c.set('audit', {
      action: 'guide.accept',
      target: auditTarget(scope, key, section),
      details: { inputHash: pending.inputHash, model: pending.model },
    })
    return c.json<GuideSection>(stored)
  })

  app.post('/guide/regenerate', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    c.set('audit', { action: 'guide.regenerate', target: { type: 'guide', id: repoKey(repo) } })
    if (!analyzers?.some((analyzer) => analyzer.kind === 'guide'))
      throw new HTTPException(409, { message: 'the guide analyzer is not available' })
    if (!config.forges[repo.forge])
      throw new HTTPException(404, { message: `forge ${repo.forge} is not configured` })
    const target = repoTarget(config, repo)
    authorize(c, 'knowledge:write', { kind: 'repo', repo: target })
    const principal = authorize(c, 'analyses:run', { kind: 'repo', repo: target })
    const input = await readBody(c, regenerateSchema)
    const job = await store.jobs.enqueue({
      analyzer: 'guide',
      repo,
      options: {
        force: true,
        ...(input.sections && { sections: input.sections }),
        ...(input.prompt && { prompt: input.prompt }),
      },
      trigger: 'manual',
      createdAt: now().toISOString(),
      actor: principal.id,
    })
    c.set('audit', {
      action: 'guide.regenerate',
      target: { type: 'job', id: job.id, repo: repoKey(repo) },
      details: {
        ...(input.sections && { sections: input.sections }),
        ...(input.prompt && { prompt: input.prompt }),
      },
    })
    return c.json<Job>(job, 201)
  })

  app.get('/guide/preview', async (c) => {
    const principal = principalOf(c)
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const target = repoTarget(config, repo)
    ensure(can(principal, 'knowledge:read', { kind: 'repo', repo: target }), 'knowledge:read')
    const task = c.req.query('task') ?? 'review'
    if (!isGuideTask(task))
      throw new HTTPException(400, { message: `task must be one of ${guideTasks.join(', ')}` })
    const section = c.req.query('section')
    if (section !== undefined && !isGuideSection(section))
      throw new HTTPException(400, {
        message: `section must be one of ${guideSections.join(', ')}`,
      })
    const resolved = await resolve({ repo: target, task, ...(section && { section }) })
    return c.json<GuidePreview>({
      repo: repoKey(repo),
      task,
      ...(section && { section }),
      ...resolved,
    })
  })

  const dismissed = async () => keysOf(await store.kv?.get(DISMISSED_KEY))

  const familyMembersOk = (principal: Principal, members: readonly string[]) =>
    members.every((member) => {
      const repo = targetOf(member)
      return repo !== undefined && can(principal, 'settings:write', { kind: 'repo', repo })
    })

  const checkMembers = (members: readonly string[]) => {
    const unknown = members.find((member) => !config.forges[member.slice(0, member.indexOf(':'))])
    if (unknown) throw new HTTPException(400, { message: `members: unknown forge in ${unknown}` })
  }

  const saveFamily = async (c: AppContext, family: Family, previous?: Family) => {
    try {
      await store.families.put(family)
    } catch (error) {
      if (error instanceof FamilyConflictError)
        throw new HTTPException(409, { message: error.message })
      throw error
    }
    const stored = (await store.families.get(family.id)) ?? family
    c.set('audit', {
      action: previous ? 'family.update' : 'family.create',
      target: { type: 'family', id: family.id },
      changes: diffChanges(previous && { name: previous.name, members: previous.members }, {
        name: stored.name,
        members: stored.members,
      }),
    })
    return stored
  }

  app.get('/families', async (c) => {
    const principal = principalOf(c)
    const readable = (member: string) => {
      const repo = targetOf(member)
      return repo !== undefined && can(principal, 'repos:read', { kind: 'repo', repo })
    }
    const families = (await store.families.list()).flatMap((family) => {
      const members = family.members.filter(readable)
      return members.length ? [{ ...family, members }] : []
    })
    return c.json<FamilyList>({ families })
  })

  app.get('/families/suggestions', async (c) => {
    const principal = principalOf(c)
    const [families, entries, tools] = await Promise.all([
      store.families.list(),
      usages.entries(() => true),
      toolchains(store.analyses),
    ])
    const signals: RepoSignals[] = entries.map((entry) => ({
      repo: entry.origin,
      dependencies: entry.data.packages.filter((pkg) => !pkg.local).map((pkg) => pkg.name),
      toolchain: tools.get(entry.origin) ?? [],
    }))
    const hidden = new Set(await dismissed())
    const suggestions = suggestFamilies(signals, {
      exclude: families.flatMap((family) => family.members),
    }).filter(
      (suggestion) =>
        !hidden.has(suggestionKey(suggestion.members)) &&
        familyMembersOk(principal, suggestion.members),
    )
    return c.json<FamilySuggestionList>({ suggestions })
  })

  app.post('/families/suggestions/dismiss', async (c) => {
    const principal = principalOf(c)
    const { members } = await readBody(c, dismissSchema)
    ensure(familyMembersOk(principal, members), 'settings:write')
    const kv = store.kv
    if (!kv) throw new HTTPException(503, { message: 'the store keeps no dismissals' })
    const key = suggestionKey(members)
    for (let attempt = 0; ; attempt++) {
      const before = await kv.get(DISMISSED_KEY)
      const keys = keysOf(before)
      if (keys.includes(key)) break
      const next = [...keys, key]
      if (!kv.compareAndSet) {
        await kv.set(DISMISSED_KEY, next)
        break
      }
      if (await kv.compareAndSet(DISMISSED_KEY, before, next)) break
      if (attempt >= 4) throw new HTTPException(409, { message: 'dismissals changed meanwhile' })
    }
    c.set('audit', {
      action: 'family.suggestion_dismiss',
      target: { type: 'family', id: key },
    })
    return c.body(null, 204)
  })

  app.post('/families', async (c) => {
    const principal = principalOf(c)
    const input = await readBody(c, familySchema)
    checkMembers(input.members)
    ensure(familyMembersOk(principal, input.members), 'settings:write')
    const at = now().toISOString()
    const family = await saveFamily(c, {
      id: crypto.randomUUID(),
      name: input.name,
      members: input.members,
      createdBy: principal.id,
      createdAt: at,
      updatedAt: at,
    })
    return c.json<Family>(family, 201)
  })

  app.put('/families/:id', async (c) => {
    const principal = principalOf(c)
    const previous = await store.families.get(c.req.param('id'))
    if (!previous) throw new HTTPException(404, { message: 'family not found' })
    const input = await readBody(c, familySchema)
    checkMembers(input.members)
    ensure(
      familyMembersOk(principal, [...new Set([...previous.members, ...input.members])]),
      'settings:write',
    )
    const family = await saveFamily(
      c,
      {
        ...previous,
        name: input.name,
        members: input.members,
        updatedAt: now().toISOString(),
        updatedBy: principal.id,
      },
      previous,
    )
    return c.json<Family>(family)
  })

  app.delete('/families/:id', async (c) => {
    const principal = principalOf(c)
    const previous = await store.families.get(c.req.param('id'))
    if (!previous) throw new HTTPException(404, { message: 'family not found' })
    ensure(familyMembersOk(principal, previous.members), 'settings:write')
    await store.families.remove(previous.id)
    await store.guides.removeScope(`family:${previous.id}`)
    const at = now().toISOString()
    for (const candidate of await store.learnings.list({ status: ['accepted'] })) {
      if (candidate.acceptedScope !== `family:${previous.id}`) continue
      const { acceptedScope: _, decidedBy: _by, decidedAt: _at, ...rest } = candidate
      await store.learnings.put({ ...rest, status: 'proposed', updatedAt: at })
    }
    c.set('audit', {
      action: 'family.delete',
      target: { type: 'family', id: previous.id },
      changes: diffChanges({ name: previous.name, members: previous.members }, undefined),
    })
    return c.body(null, 204)
  })

  return app
}
