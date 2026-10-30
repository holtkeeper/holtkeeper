import type { Scope } from '@holtkeeper/access'
import { can } from '@holtkeeper/access'
import {
  type AiProvider,
  isAiProviderKind,
  listProviderModels,
  pingAiSdkProvider,
  providerOptionsIssues,
} from '@holtkeeper/agent'
import type {
  CredentialList,
  CredentialTestResult,
  CredentialView,
  ProviderModelList,
} from '@holtkeeper/api'
import { parseCredentialInput } from '@holtkeeper/credentials'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { REDACTED, diffChanges } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  principalOf,
  readBody,
} from '../context.ts'
import { credentialTestSchema } from '../schemas.ts'

const scopeTarget = (scope: Scope) => ({ kind: 'scope' as const, scope })

const auditIgnored = ['createdAt', 'updatedAt', 'id']

const secretChange = (input: unknown) =>
  typeof input === 'object' && input !== null && 'secret' in input && input.secret !== undefined
    ? [{ field: 'secret', before: REDACTED, after: REDACTED }]
    : []

/**
 * Forge accounts and API keys. Validation and sealing happen in the credential service; routes
 * only check permissions against the credential's scope.
 */
export function credentialRoutes(deps: ServerDeps) {
  const { credentials, store, vault } = deps
  const app = new Hono<Env>()

  const existing = async (c: AppContext, action: 'credentials:read' | 'credentials:write') => {
    const credential = await credentials.get(c.req.param('id') ?? '')
    if (!credential) throw new HTTPException(404, { message: 'credential not found' })
    authorize(c, action, scopeTarget(credential.scope))
    return credential
  }

  app.get('/credentials', async (c) => {
    const principal = principalOf(c)
    const visible = (await credentials.list()).filter((credential) =>
      can(principal, 'credentials:read', scopeTarget(credential.scope)),
    )
    return c.json<CredentialList>({ credentials: visible })
  })

  app.post('/credentials', async (c) => {
    const input = parseCredentialInput(await c.req.json().catch(() => undefined))
    const principal = authorize(c, 'credentials:write', scopeTarget(input.scope))
    const created = await credentials.create(input, principal.id)
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
    const principal = input.scope
      ? authorize(c, 'credentials:write', scopeTarget(input.scope))
      : principalOf(c)
    const updated = await credentials.update(credential.id, input, principal.id)
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
    await credentials.remove(credential.id, principalOf(c).id)
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
    const stored = await store.credentials.get(credential.id)
    if (!stored) throw new HTTPException(404, { message: 'credential not found' })
    return {
      kind: credential.kind,
      url: credential.url,
      secret: await vault.open(stored.secret),
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
    if (provider.kind !== 'ai-sdk') {
      throw new HTTPException(400, { message: 'only ai-sdk providers can be tested' })
    }
    const input = await readBody(c, credentialTestSchema)
    const configured = provider.options?.['model']
    const model = input.model ?? (typeof configured === 'string' ? configured : undefined)
    if (!model) throw new HTTPException(400, { message: 'name a model to test' })
    try {
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
        model,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/credentials/:id/rotate', async (c) => {
    const credential = await existing(c, 'credentials:write')
    const rotated = await credentials.rotate(credential.id, principalOf(c).id)
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
