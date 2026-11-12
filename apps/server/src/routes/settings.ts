import {
  type RepoTarget,
  type Scope,
  can,
  groupLineage,
  groupsMatch,
  scopeCoversRepo,
  scopeSchema,
} from '@holtkeeper/access'
import type {
  CommitConventionsCheckResult,
  PolicyDraftResult,
  ResolvedSettingRow,
  ResolvedSettings,
  SettingDefinitionView,
  SettingSource,
  SettingList,
  SettingView,
} from '@holtkeeper/api'
import { checkConventions } from '@holtkeeper/commit-conventions'
import { isRetiredSetting, settingCascades, unknownSettingKeys } from '@holtkeeper/settings'
import type { SettingEntry } from '@holtkeeper/store'
import { allowlistSchema } from '@holtkeeper/vuln'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { diffChanges } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  forgeFor,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { putSettingSchema } from '../schemas.ts'
import { allowlistPolicyFor, allowlistProblem, cascadeFor } from '../setting-rules.ts'
import { commitConventionsReader } from '../tools/rules.ts'
import { peopleOf } from './avatars.ts'

const ALLOWLIST = 'audit.allowlist'
const ALLOWLIST_POLICY = 'audit.allowlistPolicy'

const changesOf = (previous: SettingEntry | undefined, entry: SettingEntry | undefined) => {
  const secret = entry?.secret === true || previous?.secret === true
  return diffChanges(
    previous && { key: previous.key, scope: previous.scope, value: previous.value },
    entry && { key: entry.key, scope: entry.scope, value: entry.value },
    { secret: (field) => secret && (field === 'value' || field.startsWith('value.')) },
  )
}

const draftSchema = z.object({
  changes: z
    .array(
      z.discriminatedUnion('op', [
        z.object({
          op: z.literal('put'),
          id: z.string().min(1).optional(),
          key: z.string().min(1),
          scope: scopeSchema,
          value: z.unknown(),
        }),
        z.object({ op: z.literal('remove'), id: z.string().min(1) }),
      ]),
    )
    .min(1)
    .max(50),
})

const checkSchema = z
  .object({
    repo: z.string().min(1),
    message: z.string().min(1).max(10_000).optional(),
    branch: z.string().min(1).max(500).optional(),
  })
  .refine((input) => input.message !== undefined || input.branch !== undefined, {
    message: 'pass message, branch or both',
  })

/** Keys the resolver leaves out although they are defined: release webhooks are instance-wide only. */
const hiddenFromResolver: ReadonlySet<string> = new Set(['releases.notify'])

/**
 * Settings per scope: AI provider and budget, access, integrations, analyzer options, ... Entries
 * and definitions of retired keys are never listed and refuse new values. `PUT /settings` writes
 * one entry, `POST /settings/draft` several at once (all or nothing, one audit event); both refuse
 * `audit.allowlist` entries that break the `audit.allowlistPolicy` covering their scope. Listed
 * and resolved entries whose value carries keys the definition no longer knows get `unknownKeys`.
 * `POST /commit-conventions/check` checks a message or branch name as `check_commit_message` does.
 */
export function settingRoutes(deps: ServerDeps) {
  const { store, vault, config } = deps
  const live = deps.settings.filter((definition) => !isRetiredSetting(definition.key))
  const definitions = new Map(live.map((definition) => [definition.key, definition]))
  /** Secret values never leave the server; keys the definition no longer knows are flagged. */
  const toView = (entry: SettingEntry): SettingView => {
    const definition = definitions.get(entry.key)
    const unknownKeys =
      definition && !entry.secret ? unknownSettingKeys(definition, entry.value) : []
    return {
      id: entry.id,
      key: entry.key,
      scope: entry.scope,
      value: entry.secret ? null : entry.value,
      secret: entry.secret,
      updatedAt: entry.updatedAt,
      ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
      ...(unknownKeys.length ? { unknownKeys } : {}),
    }
  }
  const resolvable = live.filter(
    (definition) => !definition.secret && !hiddenFromResolver.has(definition.key),
  )
  const definitionViews: SettingDefinitionView[] = live.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.description,
    section: definition.section,
    secret: definition.secret ?? false,
    default: definition.default,
    ...(definition.global ? { global: true } : {}),
    ...(definition.help ? { help: definition.help } : {}),
    ...(definition.presets?.length ? { presets: definition.presets } : {}),
    schema: z.toJSONSchema(definition.form ?? definition.schema, {
      unrepresentable: 'any',
      io: 'input',
    }),
  }))
  const app = new Hono<Env>()

  app.get('/settings', async (c) => {
    const principal = principalOf(c)
    const visible = (await store.settings.list()).filter(
      (entry) =>
        !isRetiredSetting(entry.key) &&
        can(principal, 'settings:read', { kind: 'scope', scope: entry.scope }),
    )
    return c.json<SettingList>({
      definitions: definitionViews,
      settings: visible.map(toView),
      people: await peopleOf(
        { store },
        visible.flatMap((entry) => (entry.updatedBy ? [entry.updatedBy] : [])),
      ),
    })
  })

  /** A validated write of one entry; throws 400, 403 or 404 before anything is stored. */
  const prepare = async (
    c: AppContext,
    input: { id?: string | undefined; key: string; scope: Scope; value: unknown },
    entries: readonly SettingEntry[],
  ) => {
    const definition = definitions.get(input.key)
    if (!definition) throw new HTTPException(400, { message: `unknown setting ${input.key}` })
    if (definition.global && input.scope.all !== true)
      throw new HTTPException(400, { message: `${input.key} applies to all repositories only` })
    const principal = authorize(c, 'settings:write', { kind: 'scope', scope: input.scope })

    const previous = input.id ? await store.settings.get(input.id) : undefined
    if (input.id && !previous) throw new HTTPException(404, { message: 'setting not found' })
    if (previous) authorize(c, 'settings:write', { kind: 'scope', scope: previous.scope })
    if (previous && previous.key !== input.key)
      throw new HTTPException(400, { message: 'key cannot change' })

    const parsed = definition.schema.safeParse(input.value)
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })

    const allowlist = input.key === ALLOWLIST ? allowlistSchema.safeParse(parsed.data) : undefined
    if (allowlist?.success) {
      const problem = allowlistProblem(
        allowlistPolicyFor(entries, input.scope),
        previous?.value,
        allowlist.data,
        deps.now().toISOString().slice(0, 10),
      )
      if (problem) throw new HTTPException(400, { message: problem })
    }

    const entry: SettingEntry = {
      id: previous?.id ?? crypto.randomUUID(),
      key: input.key,
      scope: input.scope,
      value: definition.secret ? await vault.seal(JSON.stringify(parsed.data)) : parsed.data,
      secret: definition.secret ?? false,
      updatedAt: deps.now().toISOString(),
      updatedBy: principal.id,
    }
    return { entry, previous }
  }

  app.put('/settings', async (c) => {
    const input = await readBody(c, putSettingSchema)
    const { entry, previous } = await prepare(c, input, await store.settings.list())
    await store.settings.put(entry)
    c.set('audit', {
      action: previous ? 'setting.update' : 'setting.create',
      target: { type: 'setting', id: entry.id },
      changes: changesOf(previous, entry),
      details: { key: entry.key },
    })
    return c.json<SettingView>(toView(entry))
  })

  app.post('/settings/draft', async (c) => {
    const { changes } = await readBody(c, draftSchema)
    c.set('audit', { action: 'setting.draft', target: { type: 'setting', id: 'draft' } })
    const ids = changes.flatMap((change) => (change.id ? [change.id] : []))
    if (new Set(ids).size !== ids.length)
      throw new HTTPException(400, { message: 'a draft changes each entry once' })

    const stored = await store.settings.list()
    const removed = new Set(
      changes.flatMap((change) => (change.op === 'remove' ? [change.id] : [])),
    )
    const draftPolicies = changes.flatMap((change) =>
      change.op === 'put' && change.key === ALLOWLIST_POLICY
        ? [
            {
              id: change.id ?? `draft-${crypto.randomUUID()}`,
              key: change.key,
              scope: change.scope,
              value: change.value,
              secret: false,
              updatedAt: deps.now().toISOString(),
            } satisfies SettingEntry,
          ]
        : [],
    )
    const replaced = new Set(draftPolicies.map((entry) => entry.id))
    const planned = [
      ...stored.filter((entry) => !removed.has(entry.id) && !replaced.has(entry.id)),
      ...draftPolicies,
    ]

    const puts: { entry: SettingEntry; previous?: SettingEntry | undefined }[] = []
    const removals: SettingEntry[] = []
    for (const change of changes) {
      if (change.op === 'remove') {
        const entry = await store.settings.get(change.id)
        if (!entry || isRetiredSetting(entry.key))
          throw new HTTPException(404, { message: `setting ${change.id} not found` })
        authorize(c, 'settings:write', { kind: 'scope', scope: entry.scope })
        removals.push(entry)
        continue
      }
      if (definitions.get(change.key)?.secret)
        throw new HTTPException(400, { message: `${change.key} is secret; save it on its own` })
      puts.push(await prepare(c, change, planned))
    }

    for (const { entry } of puts) await store.settings.put(entry)
    for (const entry of removals) await store.settings.remove(entry.id)
    const keys = [
      ...new Set([...puts.map(({ entry }) => entry.key), ...removals.map((e) => e.key)]),
    ]
    c.set('audit', {
      action: 'setting.draft',
      target: { type: 'setting', id: puts[0]?.entry.id ?? removals[0]?.id ?? 'draft' },
      changes: [
        ...puts.flatMap(({ entry, previous }) =>
          changesOf(previous, entry).map((change) => ({
            ...change,
            field: `${entry.key}#${entry.id}.${change.field}`,
          })),
        ),
        ...removals.flatMap((entry) =>
          changesOf(entry, undefined).map((change) => ({
            ...change,
            field: `${entry.key}#${entry.id}.${change.field}`,
          })),
        ),
      ],
      details: { keys, saved: puts.length, removed: removals.length },
    })
    return c.json<PolicyDraftResult>({
      saved: puts.map(({ entry }) => toView(entry)),
      removed: removals.map((entry) => entry.id),
    })
  })

  app.delete('/settings/:id', async (c) => {
    const entry = await store.settings.get(c.req.param('id'))
    if (!entry) throw new HTTPException(404, { message: 'setting not found' })
    authorize(c, 'settings:write', { kind: 'scope', scope: entry.scope })
    await store.settings.remove(entry.id)
    c.set('audit', {
      action: 'setting.delete',
      target: { type: 'setting', id: entry.id },
      changes: diffChanges({ key: entry.key, scope: entry.scope, value: entry.value }, undefined, {
        secret: (field) => entry.secret && (field === 'value' || field.startsWith('value.')),
      }),
      details: { key: entry.key },
    })
    return c.body(null, 204)
  })

  /**
   * The focus as a repository target and the entries that apply to it. A group focus stands for a
   * member no narrower entry names: only entries covering everything or the group count, and their
   * path patterns are ignored.
   */
  const focusOf = async (c: AppContext) => {
    const entries = (await store.settings.list()).filter((entry) => !isRetiredSetting(entry.key))
    const group = c.req.query('group')
    if (group) {
      const definition = config.groups[group]
      if (!definition) throw new HTTPException(404, { message: `group ${group} is not configured` })
      authorize(c, 'settings:read', { kind: 'scope', scope: { groups: [group] } })
      const target: RepoTarget = { forge: definition.forge, path: '', groups: groupLineage(group) }
      const originals = new Map(entries.map((entry) => [entry.id, entry]))
      const covering = entries.flatMap((entry) => {
        if (!entry.scope.all && !groupsMatch(entry.scope.groups ?? [], target.groups)) return []
        const scope = entry.scope.all ? { all: true } : { groups: entry.scope.groups ?? [] }
        return [{ ...entry, scope }]
      })
      const original = (entry: SettingEntry) => originals.get(entry.id) ?? entry
      return { focus: { group }, target, entries: covering, original }
    }
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo or group is required' })
    const target = repoTarget(config, repo)
    authorize(c, 'settings:read', { kind: 'repo', repo: target })
    return { focus: { repo }, target, entries, original: (entry: SettingEntry) => entry }
  }

  app.get('/settings/resolve', async (c) => {
    const { focus, target, entries, original } = await focusOf(c)
    const view = (entry: SettingEntry) => toView(original(entry))
    const sourceOf = (entry: SettingEntry): SettingSource => {
      const { scope } = entry
      if (scope.repos?.length && scopeCoversRepo({ repos: scope.repos }, target))
        return { layer: 'repo', entry: view(entry) }
      const groups = (scope.groups ?? [])
        .filter((match) => groupsMatch([match], target.groups))
        .flatMap((match) => (typeof match === 'string' ? [match] : match))
      if (!scope.all && groups.length)
        return { layer: 'group', groups: [...new Set(groups)], entry: view(entry) }
      return { layer: 'org', entry: view(entry) }
    }
    const cascades = settingCascades(entries, target)
    const rows = resolvable.map((definition): ResolvedSettingRow => {
      const [entry, ...overridden] = cascadeFor(entries, definition, target)
      const { key, label, section } = definition
      if (!entry)
        return {
          key,
          label,
          section,
          value: definition.default,
          source: { layer: 'default' },
          overrides: 0,
        }
      const [next] = overridden
      const source = sourceOf(entry)
      return {
        key,
        label,
        section,
        value: source.entry?.value ?? null,
        source,
        replaces: next
          ? { ...sourceOf(next), value: view(next).value }
          : { layer: 'default', value: definition.default },
        ...(source.entry && { entry: source.entry }),
        overrides: overridden.length,
      }
    })
    return c.json<ResolvedSettings>({
      ...focus,
      groups: target.groups,
      settings: Object.fromEntries(
        [...cascades].flatMap(([key, [winner]]) => (winner ? [[key, view(winner)]] : [])),
      ),
      cascade: Object.fromEntries([...cascades].map(([key, cascade]) => [key, cascade.map(view)])),
      rows,
    })
  })

  const conventions = commitConventionsReader({
    forgeOf: (forge) => forgeFor(config, forge),
    settings: store.settings,
    now: deps.now,
  })

  app.post('/commit-conventions/check', async (c) => {
    const input = await readBody(c, checkSchema)
    const repo = parseRepo(input.repo)
    if (!repo) throw new HTTPException(400, { message: 'repo must be forge:path' })
    if (!config.forges[repo.forge])
      throw new HTTPException(400, { message: `forge ${repo.forge} is not configured` })
    const target = repoTarget(config, repo)
    authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    const checks = checkConventions(await conventions(target), {
      ...(input.message !== undefined && { message: input.message }),
      ...(input.branch !== undefined && { branch: input.branch }),
    })
    const problems = checks.flatMap(({ target: checked, problems: found }) =>
      found.map((problem) => ({
        target: checked,
        rule: problem.rule ?? 'pattern',
        message: problem.message,
        severity: problem.severity,
        source: problem.source,
      })),
    )
    return c.json<CommitConventionsCheckResult>({
      ok: problems.every((problem) => problem.severity !== 'error'),
      problems,
    })
  })

  return app
}
