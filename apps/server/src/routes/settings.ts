import { can } from '@holtkeeper/access'
import type {
  ResolvedSettings,
  SettingDefinitionView,
  SettingList,
  SettingView,
} from '@holtkeeper/api'
import { resolveSettings } from '@holtkeeper/settings'
import type { SettingEntry } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { diffChanges } from '../audit.ts'
import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { putSettingSchema } from '../schemas.ts'
import { peopleOf } from './avatars.ts'

/** Secret values never leave the server. */
const toView = (entry: SettingEntry): SettingView => ({
  id: entry.id,
  key: entry.key,
  scope: entry.scope,
  value: entry.secret ? null : entry.value,
  secret: entry.secret,
  updatedAt: entry.updatedAt,
  ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
})

/** Settings per scope: AI models and keys, audit policy, review rules, ... */
export function settingRoutes(deps: ServerDeps) {
  const { store, vault, config } = deps
  const definitions = new Map(deps.settings.map((definition) => [definition.key, definition]))
  const definitionViews: SettingDefinitionView[] = deps.settings.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.description,
    section: definition.section,
    secret: definition.secret ?? false,
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
    const visible = (await store.settings.list()).filter((entry) =>
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

  app.put('/settings', async (c) => {
    const input = await readBody(c, putSettingSchema)
    const definition = definitions.get(input.key)
    if (!definition) throw new HTTPException(400, { message: `unknown setting ${input.key}` })
    const principal = authorize(c, 'settings:write', { kind: 'scope', scope: input.scope })

    const previous = input.id ? await store.settings.get(input.id) : undefined
    if (input.id && !previous) throw new HTTPException(404, { message: 'setting not found' })
    if (previous) authorize(c, 'settings:write', { kind: 'scope', scope: previous.scope })
    if (previous && previous.key !== input.key)
      throw new HTTPException(400, { message: 'key cannot change' })

    const parsed = definition.schema.safeParse(input.value)
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })

    const entry: SettingEntry = {
      id: previous?.id ?? crypto.randomUUID(),
      key: input.key,
      scope: input.scope,
      value: definition.secret ? await vault.seal(JSON.stringify(parsed.data)) : parsed.data,
      secret: definition.secret ?? false,
      updatedAt: deps.now().toISOString(),
      updatedBy: principal.id,
    }
    await store.settings.put(entry)
    const secret = entry.secret || previous?.secret === true
    c.set('audit', {
      action: previous ? 'setting.update' : 'setting.create',
      target: { type: 'setting', id: entry.id },
      changes: diffChanges(
        previous && { key: previous.key, scope: previous.scope, value: previous.value },
        { key: entry.key, scope: entry.scope, value: entry.value },
        { secret: (field) => secret && (field === 'value' || field.startsWith('value.')) },
      ),
      details: { key: entry.key },
    })
    await store.activity.append({
      at: entry.updatedAt,
      actor: principal.id,
      action: previous ? 'setting.updated' : 'setting.created',
      subject: entry.key,
      details: { id: entry.id, scope: entry.scope },
    })
    return c.json<SettingView>(toView(entry))
  })

  app.delete('/settings/:id', async (c) => {
    const entry = await store.settings.get(c.req.param('id'))
    if (!entry) throw new HTTPException(404, { message: 'setting not found' })
    const principal = authorize(c, 'settings:write', { kind: 'scope', scope: entry.scope })
    await store.settings.remove(entry.id)
    c.set('audit', {
      action: 'setting.delete',
      target: { type: 'setting', id: entry.id },
      changes: diffChanges({ key: entry.key, scope: entry.scope, value: entry.value }, undefined, {
        secret: (field) => entry.secret && (field === 'value' || field.startsWith('value.')),
      }),
      details: { key: entry.key },
    })
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'setting.removed',
      subject: entry.key,
      details: { id: entry.id, scope: entry.scope },
    })
    return c.body(null, 204)
  })

  app.get('/settings/resolve', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const target = repoTarget(config, repo)
    authorize(c, 'settings:read', { kind: 'repo', repo: target })
    const resolved = resolveSettings(await store.settings.list(), target)
    return c.json<ResolvedSettings>({
      repo,
      groups: target.groups,
      settings: Object.fromEntries([...resolved].map(([key, entry]) => [key, toView(entry)])),
    })
  })

  return app
}
