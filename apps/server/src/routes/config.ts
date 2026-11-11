import type {
  ConfigEntryDetail,
  ConfigEntryList,
  ConfigEntryView,
  ConfigViewData,
  ForgeRepositoryList,
  ForgeSshKeyInput,
  ForgeSshKeyResult,
  ForgeWebhookInput,
  ForgeWebhookResult,
  RepoAccessView,
  SchedulePreview,
} from '@holtkeeper/api'
import { ConfigError, type HoltkeeperConfig } from '@holtkeeper/core'
import type { CredentialView } from '@holtkeeper/credentials'
import { localRunner } from '@holtkeeper/exec'
import { type WebhookTarget, forgeErrorStatus, webhookEvents } from '@holtkeeper/forge'
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
  generateWebhookSecret,
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
  forgeFor,
  readBody,
} from '../context.ts'
import { issueForgeSshKey, removeForgeSshKey, sshKeyView } from '../ssh-keys.ts'

/** URL segment of each document type. */
const configCollections: Record<string, ConfigDocumentType> = {
  forges: 'forge',
  groups: 'group',
  'repo-traits': 'repoTraits',
  schedules: 'schedule',
  triggers: 'trigger',
}

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

const sshKeyInputSchema = z.object({
  usage: z.enum(['auth', 'signing', 'auth_and_signing']).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  identity: z.object({ name: z.string().trim().min(1), email: z.email() }).optional(),
})

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const triggersOf = (config: HoltkeeperConfig): [string, TriggerDocumentData][] => {
  const jobs = config.jobs
  const list: TriggerDocumentData[] = [
    ...(jobs.onTag ? [{ on: 'tag' as const, ...jobs.onTag }] : []),
    ...(jobs.onPush ? [{ on: 'push' as const, ...jobs.onPush }] : []),
    ...(jobs.onMergeRequest ? [{ on: 'mergeRequest' as const, ...jobs.onMergeRequest }] : []),
    ...(jobs.onNewRepo ? [{ on: 'newRepo' as const, ...jobs.onNewRepo }] : []),
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

const audit = (
  c: AppContext,
  action: string,
  type: ConfigDocumentType,
  id: string,
  details: Record<string, unknown> = {},
) => c.set('audit', { action, target: { type, id }, details })

/**
 * Panel-managed configuration: CRUD for forges, groups, repo traits, schedules and triggers
 * (`/config/<collection>[/:id]`), forge webhooks and schedule previews. Reading needs global
 * `settings:read`, changing global `settings:write`; every change is audited with the document as
 * target.
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
    credentials: ReadonlyMap<string, CredentialView>,
  ): ConfigEntryView[] => {
    const { config } = effective
    const docOf = (id: string) => docs.find((doc) => doc.type === type && doc.id === id)
    const entry = (
      id: string,
      data: ConfigViewData[ConfigDocumentType],
      doc = docOf(id),
    ): ConfigEntryView => ({
      type,
      id,
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
          const sshKey =
            doc?.type === 'forge' && doc.data.sshKey
              ? sshKeyView(doc.data.sshKey, credentials.get(doc.data.sshKey.credentialId))
              : undefined
          return entry(id, {
            kind: origin.kind,
            url: origin.url,
            credentialId: origin.credentialId,
            ...(doc?.type === 'forge' && {
              packages: doc.data.packages !== false,
              cachePackages: doc.data.packages !== false && doc.data.cachePackages === true,
              ...(doc.data.botUsername !== undefined && { botUsername: doc.data.botUsername }),
            }),
            ...(webhook && {
              webhook: {
                url: `${publicUrlOf(deps, c)}/api/webhooks/${id}`,
                createdAt: webhook.createdAt,
                ...(webhook.registered && { registered: webhook.registered }),
              },
            }),
            ...(sshKey && { sshKey }),
          })
        })
      case 'group':
        return Object.entries(config.groups).map(([id, group]) => entry(id, group))
      case 'repoTraits':
        return Object.entries(config.repos).map(([pattern, repo]) => {
          const doc = docs.find((d) => d.type === 'repoTraits' && d.data.pattern === pattern)
          return entry(
            doc?.id ?? pattern,
            {
              pattern,
              ...(repo.forge !== undefined && { forge: repo.forge }),
              traits: repo.traits,
            },
            doc,
          )
        })
      case 'schedule':
        return config.jobs.schedules.map((schedule) => {
          const { name, title, ...rest } = schedule
          return entry(name, { ...rest, name: title ?? name })
        })
    }
    return triggersOf(config).map(([id, data]) => entry(id, data))
  }

  const credentialViews = async (type: ConfigDocumentType) =>
    new Map(
      type === 'forge'
        ? (await deps.credentials.list()).map((credential) => [credential.id, credential])
        : [],
    )

  const findEntry = async (c: AppContext, type: ConfigDocumentType, id: string) => {
    const { source, store } = managed()
    const docs = await store.list()
    const found = view(c, source.effective(), docs, type, await credentialViews(type)).find(
      (entry) => entry.id === id,
    )
    if (!found) throw new HTTPException(404, { message: `${type} ${id} not found` })
    return found
  }

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

  app.get('/config/:collection', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const type = typeOf(c.req.param('collection'))
    const { source, store } = managed()
    return c.json<ConfigEntryList>({
      entries: view(c, source.effective(), await store.list(), type, await credentialViews(type)),
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
        const stored = (await store.get('forge', id))?.data
        input = {
          ...meta,
          type,
          data: {
            ...data,
            ...(stored?.webhook && { webhook: stored.webhook }),
            ...(stored?.sshKey && { sshKey: stored.sshKey }),
          },
        }
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
    audit(c, `${type}.${previous ? 'update' : 'create'}`, type, id, {
      version: stored.version,
    })
    return c.json<ConfigEntryView>(await findEntry(c, type, id))
  })

  app.delete('/config/:collection/:id', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
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
    const sshKey = type === 'forge' ? (await store.get('forge', id))?.data.sshKey : undefined
    if (sshKey) {
      const errors = await removeForgeSshKey({
        sshKey,
        forge: deps.config.forges[id]?.create(),
        credentials: deps.credentials,
      }).catch((error: unknown) => [messageOf(error)])
      if (errors.length) details.sshKeyErrors = errors
    }
    await store.remove(type, id)
    await source.refresh()
    audit(c, `${type}.delete`, type, id, details)
    return c.body(null, 204)
  })

  app.post('/forges/:id/webhook', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const id = c.req.param('id')
    const input: ForgeWebhookInput = await readBody(c, webhookInputSchema)
    const { store } = managed()
    const doc = await store.get('forge', id)
    if (!doc) throw new HTTPException(404, { message: `forge ${id} not found` })
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
            events: [...webhookEvents],
          })
          const hooks = registration.hooks.map((hook) => ({
            hookId: hook.id,
            scope: hook.scope,
            target: hook.target,
            url,
            events: [...webhookEvents],
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
    audit(c, doc.data.webhook ? 'forge.webhook_rotate' : 'forge.webhook_create', 'forge', id, {
      registered: result.registered.map((hook) => `${hook.scope}:${hook.target}`),
      ...(result.notes.length && { notes: result.notes }),
      ...(result.errors.length && { errors: result.errors }),
    })
    return c.json<ForgeWebhookResult>(result, 201)
  })

  app.get('/forges/:id/repositories', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const id = c.req.param('id')
    const forge = forgeFor(deps.config, id)
    if (!forge.listMemberRepositories)
      throw new HTTPException(409, { message: `forge ${id} cannot list its repositories` })
    let repositories: Awaited<ReturnType<typeof forge.listMemberRepositories>>
    try {
      repositories = await forge.listMemberRepositories({
        search: c.req.query('search'),
        limit: Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100),
      })
    } catch (error) {
      throw new HTTPException(502, { message: `repositories not listed: ${messageOf(error)}` })
    }
    return c.json<ForgeRepositoryList>({
      entries: repositories.map(({ path, name, webUrl }) => ({ path, name, webUrl })),
    })
  })

  app.get('/forges/:id/repositories/access', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const path = c.req.query('path')?.trim()
    if (!path) throw new HTTPException(400, { message: 'path is required' })
    const forge = forgeFor(deps.config, c.req.param('id'))
    const account = await forge.getCurrentUser?.().then(
      ({ username, name }) => ({ username, name }),
      () => undefined,
    )
    const withAccount = (answer: RepoAccessView): RepoAccessView =>
      account ? { ...answer, account } : answer
    try {
      const repository = await forge.getRepository(path)
      return c.json(
        withAccount({
          status: repository.archived ? 'archived' : 'ok',
          repository: { path: repository.path, name: repository.name, webUrl: repository.webUrl },
        }),
      )
    } catch (error) {
      const status = forgeErrorStatus(error)
      return c.json(
        withAccount({
          status:
            status === 404
              ? 'not-found'
              : status === 401
                ? 'unauthorized'
                : status === 403
                  ? 'forbidden'
                  : 'error',
          message: messageOf(error),
        }),
      )
    }
  })

  const panelForge = async (id: string) => {
    const doc = await managed().store.get('forge', id)
    if (!doc) throw new HTTPException(404, { message: `forge ${id} not found` })
    return doc
  }

  app.post('/forges/:id/ssh-key', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const id = c.req.param('id')
    const input: ForgeSshKeyInput = await readBody(c, sshKeyInputSchema)
    const doc = await panelForge(id)
    const forge = forgeFor(deps.config, id)
    if (!forge.registerSshKey)
      throw new HTTPException(409, { message: `forge ${id} cannot register SSH keys` })
    let issued: Awaited<ReturnType<typeof issueForgeSshKey>>
    try {
      issued = await issueForgeSshKey({
        forgeId: id,
        doc,
        forge,
        credentials: deps.credentials,
        input,
        runner: deps.hostRunner ?? localRunner,
        now: deps.now(),
      })
    } catch (error) {
      throw new HTTPException(502, { message: `SSH key not issued: ${messageOf(error)}` })
    }
    await save<'forge'>({
      ...doc,
      data: { ...doc.data, sshKey: issued.sshKey },
      updatedAt: deps.now().toISOString(),
      updatedBy: principal.id,
    })
    audit(c, doc.data.sshKey ? 'forge.ssh_key_rotate' : 'forge.ssh_key_create', 'forge', id, {
      credentialId: issued.sshKey.credentialId,
      ...(issued.notes.length && { notes: issued.notes }),
    })
    const sshKey = sshKeyView(issued.sshKey, await deps.credentials.get(issued.sshKey.credentialId))
    if (!sshKey) throw new HTTPException(500, { message: 'the issued SSH key cannot be read back' })
    return c.json<ForgeSshKeyResult>({ sshKey, notes: issued.notes }, 201)
  })

  app.delete('/forges/:id/ssh-key', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const id = c.req.param('id')
    const doc = await panelForge(id)
    const sshKey = doc.data.sshKey
    if (!sshKey) throw new HTTPException(404, { message: `forge ${id} has no SSH key` })
    const errors = await removeForgeSshKey({
      sshKey,
      forge: deps.config.forges[id]?.create(),
      credentials: deps.credentials,
    })
    const { sshKey: _removed, ...data } = doc.data
    await save<'forge'>({
      ...doc,
      data,
      updatedAt: deps.now().toISOString(),
      updatedBy: principal.id,
    })
    audit(c, 'forge.ssh_key_delete', 'forge', id, {
      credentialId: sshKey.credentialId,
      ...(errors.length && { errors }),
    })
    return c.body(null, 204)
  })

  app.get('/schedules/:id/preview', (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const id = c.req.param('id')
    const schedule = deps.config.jobs.schedules.find((s) => s.name === id)
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
