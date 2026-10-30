import type {
  ConfigEntryDetail,
  ConfigEntryList,
  ConfigEntryView,
  ConfigViewData,
  ForgeWebhookInput,
  ForgeWebhookResult,
  SchedulePreview,
} from '@holtkeeper/api'
import { ConfigError, type HoltkeeperConfig } from '@holtkeeper/core'
import type { WebhookEvent, WebhookTarget } from '@holtkeeper/forge'
import { nextRuns, staticPrefix, systemTimeZone } from '@holtkeeper/jobs'
import {
  type ConfigSource,
  type EffectiveConfig,
  configIdSchema,
  forgeDataSchema,
  groupDataSchema,
  repoTraitsDataSchema,
  scheduleDataSchema,
  triggerDataSchema,
  exportConfig,
  generateWebhookSecret,
  provenanceKey,
  triggerId,
} from '@holtkeeper/managed-config'
import type {
  AnyConfigDocument,
  ConfigDocumentInput,
  ConfigDocumentType,
  ConfigStore,
  RegisteredWebhook,
  TriggerDocumentData,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  publicUrlOf,
  readBody,
} from '../context.ts'

/** URL segment of each document type. */
const configCollections: Record<string, ConfigDocumentType> = {
  forges: 'forge',
  groups: 'group',
  'repo-traits': 'repoTraits',
  schedules: 'schedule',
  triggers: 'trigger',
}

/** Events a registered forge webhook delivers. */
const WEBHOOK_EVENTS: WebhookEvent[] = ['tag_push', 'merge_request', 'note', 'pipeline']

const GLOBAL = { kind: 'global' } as const

type AnyDocumentInput = { [T in ConfigDocumentType]: ConfigDocumentInput<T> }[ConfigDocumentType]

const webhookInputSchema = z.object({
  register: z.boolean().optional(),
  targets: z
    .array(
      z
        .object({ group: z.string().min(1).optional(), project: z.string().min(1).optional() })
        .refine(
          (t) => (t.group === undefined) !== (t.project === undefined),
          'set group or project',
        ),
    )
    .optional(),
})

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const triggersOf = (config: HoltkeeperConfig): [string, TriggerDocumentData][] => {
  const jobs = config.jobs
  if (!jobs) return []
  const list: TriggerDocumentData[] = [
    ...(jobs.onTag ? [{ on: 'tag' as const, ...jobs.onTag }] : []),
    ...(jobs.onMergeRequest ? [{ on: 'mergeRequest' as const, ...jobs.onMergeRequest }] : []),
    ...Object.entries(jobs.onLabel ?? {}).map(([label, analyzers]) => ({
      on: 'label' as const,
      label,
      analyzers,
    })),
    ...Object.entries(jobs.commands ?? {}).map(([command, definition]) => ({
      on: 'command' as const,
      command,
      ...definition,
    })),
  ]
  return list.map((data) => [triggerId(data), data])
}

/** Hook targets on the forge for a forge's groups: group paths for globs, projects for exact paths. */
export function defaultWebhookTargets(config: HoltkeeperConfig, forgeId: string): WebhookTarget[] {
  const targets = new Map<string, WebhookTarget>()
  for (const group of Object.values(config.groups)) {
    if (group.forge !== forgeId) continue
    for (const pattern of group.include) {
      const prefix = staticPrefix(pattern)
      if (!prefix) continue
      if (prefix === pattern) targets.set(`project:${prefix}`, { project: prefix })
      else targets.set(`group:${prefix}`, { group: prefix })
    }
  }
  return [...targets.values()]
}

const sameHook = (a: RegisteredWebhook, b: { scope: string; target: string }) =>
  a.scope === b.scope && a.target === b.target

const typeOf = (collection: string): ConfigDocumentType => {
  const type = configCollections[collection]
  if (!type) throw new HTTPException(404, { message: `unknown config collection ${collection}` })
  return type
}

/**
 * Panel-managed configuration: CRUD for forges, groups, repo traits, schedules and triggers
 * (`/config/<collection>[/:id]`), forge webhooks, export and schedule previews. Reading needs global
 * `settings:read`, changing global `settings:write`; every change is in the activity log.
 */
export function configRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const managed = (): { source: ConfigSource; store: ConfigStore } => {
    const source = deps.configSource
    const store = deps.store.config
    if (!source || !store)
      throw new HTTPException(503, { message: 'panel-managed configuration is not available' })
    return { source, store }
  }

  const view = (
    c: AppContext,
    effective: EffectiveConfig,
    docs: readonly AnyConfigDocument[],
    type: ConfigDocumentType,
  ): ConfigEntryView[] => {
    const { config, provenance } = effective
    const docOf = (id: string) => docs.find((doc) => doc.type === type && doc.id === id)
    const entry = (
      id: string,
      key: string,
      data: ConfigViewData[ConfigDocumentType],
      doc = docOf(id),
    ): ConfigEntryView => ({
      type,
      id,
      provenance: provenance[provenanceKey(type, key)] ?? 'file',
      data,
      ...(doc && {
        version: doc.version,
        updatedAt: doc.updatedAt,
        ...(doc.updatedBy !== undefined && { updatedBy: doc.updatedBy }),
      }),
    })
    switch (type) {
      case 'forge':
        return Object.entries(effective.forges).map(([id, origin]) => {
          const doc = docOf(id)
          const webhook = doc?.type === 'forge' ? doc.data.webhook : undefined
          return entry(id, id, {
            kind: origin.kind,
            url: origin.url,
            ...(origin.credentialId !== undefined && { credentialId: origin.credentialId }),
            ...(webhook && {
              webhook: {
                url: `${publicUrlOf(deps, c)}/api/webhooks/${id}`,
                createdAt: webhook.createdAt,
                ...(webhook.registered && { registered: webhook.registered }),
              },
            }),
          })
        })
      case 'group':
        return Object.entries(config.groups).map(([id, group]) => entry(id, id, group))
      case 'repoTraits':
        return Object.entries(config.repos).map(([pattern, repo]) => {
          const doc = docs.find((d) => d.type === 'repoTraits' && d.data.pattern === pattern)
          return entry(
            doc?.id ?? pattern,
            pattern,
            {
              pattern,
              ...(repo.forge !== undefined && { forge: repo.forge }),
              traits: repo.traits,
            },
            doc,
          )
        })
      case 'schedule':
        return (config.jobs?.schedules ?? []).map((schedule) => {
          const { name, title, ...rest } = schedule
          return entry(name, name, { ...rest, name: title ?? name })
        })
    }
    return triggersOf(config).map(([id, data]) => entry(id, id, data))
  }

  const findEntry = async (c: AppContext, type: ConfigDocumentType, id: string) => {
    const { source, store } = managed()
    const docs = await store.list()
    const found = view(c, source.effective(), docs, type).find((entry) => entry.id === id)
    if (!found) throw new HTTPException(404, { message: `${type} ${id} not found` })
    return found
  }

  const activity = (
    actor: string,
    action: string,
    type: ConfigDocumentType,
    id: string,
    details: Record<string, unknown> = {},
  ) =>
    deps.store.activity.append({
      at: deps.now().toISOString(),
      actor,
      action,
      subject: `${type}:${id}`,
      details,
    })

  /** Validates the change against the whole config, stores it and rebuilds. */
  const save = async <T extends ConfigDocumentType>(input: ConfigDocumentInput<T>) => {
    const { source, store } = managed()
    try {
      await source.preview({ put: input })
    } catch (error) {
      if (error instanceof ConfigError) throw new HTTPException(400, { message: error.message })
      throw error
    }
    const stored = await store.put(input)
    await source.refresh()
    return stored
  }

  app.get('/config/export', (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const { source } = managed()
    return c.body(exportConfig(source.effective()), 200, {
      'content-type': 'text/typescript; charset=utf-8',
      'content-disposition': 'attachment; filename="holtkeeper.config.ts"',
    })
  })

  app.get('/config/:collection', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const type = typeOf(c.req.param('collection'))
    const { source, store } = managed()
    return c.json<ConfigEntryList>({
      entries: view(c, source.effective(), await store.list(), type),
    })
  })

  app.get('/config/:collection/:id', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const type = typeOf(c.req.param('collection'))
    const id = c.req.param('id')
    const entry = await findEntry(c, type, id)
    const history = await managed().store.history(type, id)
    return c.json<ConfigEntryDetail>({ entry, history })
  })

  app.put('/config/:collection/:id', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const type = typeOf(c.req.param('collection'))
    const id = c.req.param('id')
    if (type !== 'repoTraits' && type !== 'trigger' && !configIdSchema.safeParse(id).success)
      throw new HTTPException(400, { message: 'id: use lowercase letters, digits and dashes' })
    const { store } = managed()
    const meta = { id, updatedAt: deps.now().toISOString(), updatedBy: principal.id }
    let input: AnyDocumentInput
    switch (type) {
      case 'forge': {
        const data = await readBody(c, forgeDataSchema)
        if (!(await deps.credentials.get(data.credentialId)))
          throw new HTTPException(400, {
            message: `credentialId: unknown credential ${data.credentialId}`,
          })
        const webhook = (await store.get('forge', id))?.data.webhook
        input = { ...meta, type, data: { ...data, ...(webhook && { webhook }) } }
        break
      }
      case 'group':
        input = { ...meta, type, data: await readBody(c, groupDataSchema) }
        break
      case 'repoTraits':
        input = { ...meta, type, data: await readBody(c, repoTraitsDataSchema) }
        break
      case 'schedule':
        input = { ...meta, type, data: await readBody(c, scheduleDataSchema) }
        break
      case 'trigger': {
        const data = await readBody(c, triggerDataSchema)
        if (triggerId(data) !== id)
          throw new HTTPException(400, {
            message: `id must be ${triggerId(data)} for this trigger`,
          })
        input = { ...meta, type, data }
        break
      }
    }
    const previous = await store.get(type, id)
    const stored = await save(input)
    await activity(principal.id, `config.${type}.${previous ? 'updated' : 'created'}`, type, id, {
      version: stored.version,
    })
    return c.json<ConfigEntryView>(await findEntry(c, type, id))
  })

  app.delete('/config/:collection/:id', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const type = typeOf(c.req.param('collection'))
    const id = c.req.param('id')
    const { source, store } = managed()
    const doc = await store.get(type, id)
    if (!doc) throw new HTTPException(404, { message: `no panel ${type} ${id}` })
    try {
      await source.preview({ remove: { type, id } })
    } catch (error) {
      if (error instanceof ConfigError) throw new HTTPException(409, { message: error.message })
      throw error
    }
    const details: Record<string, unknown> = { version: doc.version }
    const registered =
      type === 'forge' ? (await store.get('forge', id))?.data.webhook?.registered : undefined
    if (registered?.length) {
      try {
        await deps.config.forges[id]
          ?.create()
          .removeWebhook?.(
            registered.map((hook) => ({ id: hook.hookId, scope: hook.scope, target: hook.target })),
          )
      } catch (error) {
        details.webhookError = messageOf(error)
      }
    }
    await store.remove(type, id)
    await source.refresh()
    await activity(principal.id, `config.${type}.removed`, type, id, details)
    return c.body(null, 204)
  })

  app.post('/forges/:id/webhook', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const id = c.req.param('id')
    const input: ForgeWebhookInput = await readBody(c, webhookInputSchema)
    const { store } = managed()
    const doc = await store.get('forge', id)
    if (!doc) {
      const known = id in deps.config.forges
      throw new HTTPException(known ? 409 : 404, {
        message: known
          ? `forge ${id} comes from the config file; set jobs.webhooks.${id}.secret there`
          : `forge ${id} not found`,
      })
    }
    const previous = doc.data.webhook?.registered ?? []
    const register = input.register ?? previous.length > 0
    const targets: WebhookTarget[] =
      input.targets ??
      (previous.length
        ? [
            ...new Map(
              previous.map((hook) => [
                `${hook.scope}:${hook.target}`,
                hook.scope === 'group' ? { group: hook.target } : { project: hook.target },
              ]),
            ).values(),
          ]
        : defaultWebhookTargets(deps.config, id))
    const secret = generateWebhookSecret()
    const url = `${publicUrlOf(deps, c)}/api/webhooks/${id}`
    const result: ForgeWebhookResult = { url, secret, registered: [], notes: [], errors: [] }
    let registered = previous

    if (register) {
      const forge = deps.config.forges[id]?.create()
      if (!forge?.ensureWebhook)
        throw new HTTPException(409, { message: `forge ${id} cannot register webhooks` })
      for (const target of targets) {
        const label = target.group ? `group ${target.group}` : `project ${target.project}`
        try {
          // oxlint-disable-next-line no-await-in-loop -- one target after another keeps rate limits
          const registration = await forge.ensureWebhook(target, {
            url,
            secret,
            events: WEBHOOK_EVENTS,
          })
          const hooks = registration.hooks.map((hook) => ({
            hookId: hook.id,
            scope: hook.scope,
            target: hook.target,
            url,
          }))
          registered = [
            ...registered.filter((old) => !hooks.some((hook) => sameHook(old, hook))),
            ...hooks,
          ]
          result.registered.push(...hooks)
          if (registration.fallback) result.notes.push(registration.fallback)
        } catch (error) {
          result.errors.push({ target: label, error: messageOf(error) })
        }
      }
    }

    await save<'forge'>({
      ...doc,
      data: {
        ...doc.data,
        webhook: {
          secret: await deps.vault.seal(secret),
          createdAt: deps.now().toISOString(),
          ...(registered.length && { registered }),
        },
      },
      updatedAt: deps.now().toISOString(),
      updatedBy: principal.id,
    })
    await activity(
      principal.id,
      doc.data.webhook ? 'config.forge.webhook_rotated' : 'config.forge.webhook_created',
      'forge',
      id,
      {
        registered: result.registered.map((hook) => `${hook.scope}:${hook.target}`),
        ...(result.notes.length && { notes: result.notes }),
        ...(result.errors.length && { errors: result.errors }),
      },
    )
    return c.json<ForgeWebhookResult>(result, 201)
  })

  app.get('/schedules/:id/preview', (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const id = c.req.param('id')
    const schedule = deps.config.jobs?.schedules.find((s) => s.name === id)
    if (!schedule) throw new HTTPException(404, { message: `schedule ${id} not found` })
    const count = Math.min(Math.max(Number(c.req.query('count')) || 10, 1), 100)
    const timezone = schedule.timezone ?? systemTimeZone()
    return c.json<SchedulePreview>({
      id,
      timezone,
      runs: nextRuns(schedule, deps.now(), count, { timezone }).map((run) => run.toISOString()),
    })
  })

  return app
}
