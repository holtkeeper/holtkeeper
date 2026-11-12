import type { Scope } from '@holtkeeper/access'
import { can } from '@holtkeeper/access'
import {
  type AiProvider,
  isAiProviderKind,
  listProviderModels,
  pingAiSdkProvider,
  probeAgentLoop,
  resolveTierModels,
  providerOptionsIssues,
} from '@holtkeeper/agent'
import type {
  CredentialList,
  CredentialTestResult,
  CredentialUseView,
  CredentialView,
  IntegrationForgeList,
  ProviderModelList,
} from '@holtkeeper/api'
import { parseCredentialInput } from '@holtkeeper/credentials'
import { resolveGlobalSetting } from '@holtkeeper/settings'
import type { CredentialCapabilities, ForgeDocumentData } from '@holtkeeper/store'
import { webPaths } from '@holtkeeper/web-paths'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { providerReference } from '../agent.ts'
import { REDACTED, diffChanges } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  principalOf,
  readBody,
} from '../context.ts'
import { EGRESS_SECRET_KIND } from '../egress-secrets.ts'
import { credentialTestSchema } from '../schemas.ts'
import { listedRepos } from '../updates.ts'
import { lastForgeDeliveries } from '../webhook-sync.ts'

const scopeTarget = (scope: Scope) => ({ kind: 'scope' as const, scope })

const auditIgnored = ['createdAt', 'updatedAt', 'id', 'lastUsedAt']

const secretChange = (input: unknown) =>
  typeof input === 'object' && input !== null && 'secret' in input && input.secret !== undefined
    ? [{ field: 'secret', before: REDACTED, after: REDACTED }]
    : []

const GLOBAL = { kind: 'global' } as const

/** Services that use every credential of their kind. */
const kindServices: Record<string, { id: string; label: string }> = {
  [EGRESS_SECRET_KIND]: { id: 'egress', label: 'Job network proxy' },
  jira: { id: 'jira', label: 'Issue lookups' },
  confluence: { id: 'confluence', label: 'Documents' },
}

const librariesGithubSchema = z.object({
  github: z.preprocess(
    (value) => (typeof value === 'string' ? [value] : value),
    z.array(z.string()).optional(),
  ),
})

type UsedCredential = Pick<CredentialView, 'id' | 'name' | 'kind'>

/**
 * What refers to each credential: panel forges by token or SSH key, the global `llm.provider`
 * and `libraries` settings by id or name, and the services that use every credential of a kind.
 */
async function credentialUses(
  deps: Pick<ServerDeps, 'store'>,
  credentials: readonly UsedCredential[],
): Promise<Map<string, CredentialUseView[]>> {
  const [forges, settings] = await Promise.all([
    deps.store.config?.list('forge') ?? [],
    deps.store.settings.list(),
  ])
  const integrations = webPaths.settings('integrations')
  const uses = new Map<string, CredentialUseView[]>(credentials.map((c) => [c.id, []]))
  const add = (id: string, use: CredentialUseView) => uses.get(id)?.push(use)
  const named = (reference: string) =>
    credentials.find((c) => c.id === reference) ?? credentials.find((c) => c.name === reference)

  for (const forge of forges) {
    const data: ForgeDocumentData = forge.data
    add(data.credentialId, {
      kind: 'forge',
      id: forge.id,
      label: `Forge ${forge.id}`,
      href: integrations,
    })
    if (data.sshKey)
      add(data.sshKey.credentialId, {
        kind: 'forge',
        id: forge.id,
        label: `SSH key of ${forge.id}`,
        href: integrations,
      })
  }

  const provider = providerReference(settings)
  const providerCredential = provider === undefined ? undefined : named(provider)
  if (providerCredential && isAiProviderKind(providerCredential.kind))
    add(providerCredential.id, {
      kind: 'setting',
      id: 'llm.provider',
      label: 'Agents',
      href: webPaths.settings('ai'),
    })

  const libraries = resolveGlobalSetting(settings, 'libraries')
  const parsed = librariesGithubSchema.safeParse(libraries?.value ?? {})
  const github = parsed.success ? parsed.data.github : undefined
  const indexing = github
    ? github.flatMap((reference) => {
        const found = named(reference)
        return found ? [found] : []
      })
    : credentials.filter((c) => c.kind === 'github')
  for (const credential of indexing)
    add(credential.id, {
      kind: 'setting',
      id: 'libraries',
      label: 'Library index',
      href: webPaths.settings('system'),
    })

  for (const credential of credentials) {
    const service = kindServices[credential.kind]
    if (service) add(credential.id, { kind: 'service', ...service })
  }
  return uses
}

/**
 * Forge accounts and API keys. Validation and sealing happen in the credential service; routes
 * only check permissions against the credential's scope. `POST /credentials/:id/test` pings an
 * `ai-sdk` provider; for Anthropic and Anthropic-compatible ones it probes Messages tool use
 * (`probeAgentLoop`) and stores the outcome as the credential's `capabilities.agentLoop`, which
 * decides whether agent tool loops run on the Claude Agent SDK.
 *
 * `GET /credentials` adds `usedBy` to each visible credential. `GET /integrations/forges` lists
 * panel forges with their repository counts and last webhook delivery; it needs a global
 * `settings:read`, since the counts cover every repository.
 */
export function credentialRoutes(deps: ServerDeps) {
  const { credentials, store } = deps
  const app = new Hono<Env>()

  const existing = async (c: AppContext, action: 'credentials:read' | 'credentials:write') => {
    const credential = await credentials.get(c.req.param('id') ?? '')
    if (!credential) throw new HTTPException(404, { message: 'credential not found' })
    authorize(c, action, scopeTarget(credential.scope))
    return credential
  }

  app.get('/credentials', async (c) => {
    const principal = principalOf(c)
    const all = await credentials.list()
    const visible = all.filter((credential) =>
      can(principal, 'credentials:read', scopeTarget(credential.scope)),
    )
    const uses = await credentialUses(deps, all)
    return c.json<CredentialList>({
      credentials: visible.map((credential) => ({
        ...credential,
        usedBy: uses.get(credential.id) ?? [],
      })),
    })
  })

  app.get('/integrations/forges', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const docs = (await store.config?.list('forge')) ?? []
    const [repos, deliveries] = await Promise.all([
      listedRepos(store.kv, deps.config),
      lastForgeDeliveries(
        store.kv,
        docs.map((doc) => doc.id),
      ),
    ])
    return c.json<IntegrationForgeList>({
      forges: docs.map((doc) => {
        const lastWebhookAt = deliveries.get(doc.id)
        return {
          id: doc.id,
          kind: doc.data.kind,
          url: doc.data.url,
          credentialId: doc.data.credentialId,
          repos: repos.filter((repo) => repo.forge === doc.id).length,
          ...(lastWebhookAt !== undefined && { lastWebhookAt }),
          webhook:
            doc.data.webhook !== undefined ||
            deps.config.jobs?.webhooks?.[doc.id]?.secret !== undefined,
        }
      }),
    })
  })

  app.post('/credentials', async (c) => {
    const input = parseCredentialInput(await c.req.json().catch(() => undefined))
    authorize(c, 'credentials:write', scopeTarget(input.scope))
    const created = await credentials.create(input)
    c.set('audit', {
      action: 'credential.create',
      target: { type: 'credential', id: created.id },
      changes: [
        ...diffChanges(undefined, created, { ignore: auditIgnored }),
        { field: 'secret', after: REDACTED },
      ],
    })
    return c.json<CredentialView>(created, 201)
  })

  app.patch('/credentials/:id', async (c) => {
    const credential = await existing(c, 'credentials:write')
    const input = parseCredentialInput(await c.req.json().catch(() => undefined), true)
    if (input.scope) authorize(c, 'credentials:write', scopeTarget(input.scope))
    const updated = await credentials.update(credential.id, input)
    c.set('audit', {
      action: 'credential.update',
      target: { type: 'credential', id: credential.id },
      changes: [
        ...diffChanges(credential, updated, { ignore: auditIgnored }),
        ...secretChange(input),
      ],
    })
    return c.json<CredentialView>(updated)
  })

  app.delete('/credentials/:id', async (c) => {
    const credential = await existing(c, 'credentials:write')
    await credentials.remove(credential.id)
    c.set('audit', {
      action: 'credential.delete',
      target: { type: 'credential', id: credential.id },
      changes: diffChanges(credential, undefined, { ignore: auditIgnored }),
    })
    return c.body(null, 204)
  })

  const aiProvider = async (
    c: AppContext,
    action: 'credentials:read' | 'credentials:write',
  ): Promise<AiProvider> => {
    const credential = await existing(c, action)
    if (!isAiProviderKind(credential.kind)) {
      throw new HTTPException(400, { message: 'not an AI provider credential' })
    }
    const issues = providerOptionsIssues(credential.kind, credential.options)
    if (issues.length) throw new HTTPException(400, { message: issues.join('; ') })
    return {
      kind: credential.kind,
      url: credential.url,
      secret: await credentials.open(credential.id),
      ...(credential.options && { options: credential.options }),
    }
  }

  app.get('/credentials/:id/models', async (c) => {
    const listing = await listProviderModels(await aiProvider(c, 'credentials:read'), {
      signal: AbortSignal.timeout(15_000),
      ...(deps.aiCatalog && { catalog: deps.aiCatalog }),
    })
    return c.json<ProviderModelList>(listing)
  })

  app.post('/credentials/:id/test', async (c) => {
    const provider = await aiProvider(c, 'credentials:write')
    const input = await readBody(c, credentialTestSchema)
    let model = input.model
    try {
      model ??= resolveTierModels(
        await listProviderModels(provider, {
          signal: AbortSignal.timeout(15_000),
          ...(deps.aiCatalog && { catalog: deps.aiCatalog }),
        }),
      ).main
      if (provider.kind !== 'ai-sdk') {
        const probe = await probeAgentLoop(provider, model, {
          signal: AbortSignal.timeout(30_000),
          ...(deps.probeFetch && { fetch: deps.probeFetch }),
        })
        const capabilities: CredentialCapabilities | undefined = probe.conclusive
          ? {
              agentLoop: probe.status,
              checkedAt: deps.now().toISOString(),
              ...(probe.error !== undefined && { error: probe.error }),
            }
          : (await credentials.get(c.req.param('id')))?.capabilities
        if (probe.conclusive && capabilities)
          await credentials.setCapabilities(c.req.param('id'), capabilities)
        return c.json<CredentialTestResult>({
          ok: probe.status === 'ok',
          model: probe.model,
          latencyMs: probe.latencyMs,
          ...(capabilities && { capabilities }),
          ...(probe.error !== undefined && { error: probe.error }),
        })
      }
      const reply = await pingAiSdkProvider(provider, model, {
        signal: AbortSignal.timeout(30_000),
        ...(deps.aiProviders && { plugins: deps.aiProviders }),
        ...(deps.languageModel && { languageModel: deps.languageModel }),
      })
      return c.json<CredentialTestResult>({
        ok: true,
        model,
        reply: reply.text,
        latencyMs: reply.latencyMs,
      })
    } catch (error) {
      return c.json<CredentialTestResult>({
        ok: false,
        model: model ?? '',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/credentials/:id/rotate', async (c) => {
    const credential = await existing(c, 'credentials:write')
    const rotated = await credentials.rotate(credential.id)
    c.set('audit', {
      action: 'credential.rotate',
      target: { type: 'credential', id: credential.id },
      changes: [
        ...diffChanges(credential, rotated, { ignore: auditIgnored }),
        { field: 'secret', before: REDACTED, after: REDACTED },
      ],
    })
    return c.json<CredentialView>(rotated)
  })

  return app
}
