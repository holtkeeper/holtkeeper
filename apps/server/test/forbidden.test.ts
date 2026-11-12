import { beforeEach, describe, expect, test } from 'bun:test'

import { type RegistryToolset, defineTool } from '@holtkeeper/agent-tools'
import type { Action, ForbiddenError, KnowledgeEntry } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'

import { registryServer } from '../src/api-surface/mcp.ts'
import { createApp } from '../src/app.ts'
import { ForbiddenException, ForbiddenToolError, type ServerDeps } from '../src/context.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    widgets: { forge: 'work', include: ['acme/*'] },
    gizmos: { forge: 'work', include: ['other/*'] },
  },
})

const auth = headerAuth({
  roles: {
    reader: [{ scope: { groups: ['widgets'] }, actions: ['repos:read'] }],
    spender: [{ scope: { groups: ['widgets'] }, actions: ['ai:read'] }],
    writer: [{ scope: { groups: ['gizmos'] }, actions: ['knowledge:write', 'knowledge:read'] }],
    admin: [{ scope: { all: true }, actions: ['*'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': 'jane', 'x-forwarded-groups': role })

let store: Store
const setup = (readOnly?: ServerDeps['readOnly']) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    ...(readOnly && { readOnly }),
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => new Date('2026-11-16T00:00:00.000Z'),
  })
}

beforeEach(() => {
  store = memoryStore()
})

const denied = async (
  app: ReturnType<typeof setup>,
  path: string,
  role: string,
  init: { method?: string; body?: unknown } = {},
) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...as(role),
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  expect(response.status).toBe(403)
  const text = await response.text()
  expect(text).not.toContain('widgets')
  expect(text).not.toContain('gizmos')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(text) as ForbiddenError
}

describe('403 body', () => {
  test('authorize() names the action and the repository as sent', async () => {
    const app = setup()
    const known = await denied(app, '/api/releases/timeline?repo=work:acme/gadget', 'spender')
    expect(known).toEqual({
      error: 'missing permission releases:read',
      missing: { action: 'releases:read', target: 'work:acme/gadget' },
    })
    const unknown = await denied(app, '/api/releases/timeline?repo=work:nowhere/thing', 'spender')
    expect(unknown).toEqual({
      ...known,
      missing: { ...known.missing, target: 'work:nowhere/thing' },
    })
  })

  test('global checks name only the action', async () => {
    const app = setup()
    expect(await denied(app, '/api/history', 'spender')).toEqual({
      error: 'missing permission repos:read',
      missing: { action: 'repos:read' },
    })
    expect(await denied(app, '/api/ai/usage', 'reader')).toEqual({
      error: 'missing permission ai:read',
      missing: { action: 'ai:read' },
    })
  })

  test('routes checking a repository answer the same for a hidden and a missing one', async () => {
    const app = setup()
    const pairs: [
      string,
      Action,
      (repo: string) => { path: string; method?: string; body?: unknown },
      string,
    ][] = [
      [
        'spender',
        'ai:read',
        (repo) => ({ path: `/api/ai/usage?repo=${repo}` }),
        'missing permission ai:read',
      ],
      [
        'reader',
        'repos:read',
        (repo) => ({ path: '/api/chat/threads', method: 'POST', body: { title: 'Widgets', repo } }),
        'missing permission repos:read',
      ],
      [
        'spender',
        'knowledge:read',
        (repo) => ({ path: `/api/guide/preview?repo=${repo}` }),
        'missing permission knowledge:read',
      ],
      [
        'spender',
        'knowledge:read',
        (repo) => ({ path: `/api/learnings/reactions?repo=${repo}` }),
        'missing permission knowledge:read',
      ],
    ]
    for (const [role, action, request, error] of pairs) {
      for (const repo of ['work:other/gear', 'work:nowhere/thing']) {
        const { path, ...init } = request(repo)
        // oxlint-disable-next-line no-await-in-loop -- a handful of sequential requests
        expect(await denied(app, path, role, init)).toEqual({
          error,
          missing: { action, target: repo },
        })
      }
    }
  })

  test('task groups name the repository the caller cannot see', async () => {
    const app = setup()
    for (const repo of ['work:other/gear', 'work:nowhere/thing']) {
      const body = { title: 'Bump widgets', prompt: 'Bump it', repos: [repo] }
      // oxlint-disable-next-line no-await-in-loop -- two sequential requests
      const answer = await denied(app, '/api/task-groups', 'spender', { method: 'POST', body })
      expect(answer).toEqual({
        error: `cannot see ${repo}`,
        missing: { action: 'repos:read', target: repo },
      })
    }
  })

  test('a knowledge entry of another team names only the action', async () => {
    const app = setup()
    const created = await app.request('/api/knowledge', {
      method: 'POST',
      headers: { ...as('admin'), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Prefer round widgets',
        body: 'Round widgets roll.',
        kind: 'convention',
        scope: { groups: ['gizmos'] },
        topics: ['testing'],
        appliesTo: ['review'],
        visibility: 'team',
      }),
    })
    expect(created.status).toBe(201)
    const entry = (await created.json()) as KnowledgeEntry
    expect(await denied(app, `/api/knowledge/${entry.id}`, 'reader')).toEqual({
      error: 'missing permission knowledge:read',
      missing: { action: 'knowledge:read' },
    })
    const missing = await app.request('/api/knowledge/nope', { headers: as('reader') })
    expect(missing.status).toBe(404)
  })

  test('records of a hidden repository name only the action', async () => {
    const app = setup()
    const hidden = { forge: 'work', path: 'other/secret' }
    const job = await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: hidden,
      trigger: 'manual',
      createdAt: '2026-11-15T10:00:00.000Z',
    })
    const analysis = await store.analyses.add({
      repo: hidden,
      kind: 'review',
      ref: '!3',
      createdAt: '2026-11-15T10:00:00.000Z',
      data: {},
    })
    const run = await store.auditRuns.add({
      repo: hidden,
      trigger: 'cli',
      startedAt: '2026-11-15T10:00:00.000Z',
      finishedAt: '2026-11-15T10:00:00.000Z',
      report: {
        scanner: 'osv-scanner',
        findings: [],
        ignored: [],
        expired: [],
        fixes: [],
        resolved: [],
        changedFiles: [],
      },
    })
    await store.learnings.put({
      id: 'l1',
      repo: 'work:other/secret',
      rule: 'Prefer round widgets.',
      key: 'prefer round widgets',
      section: 'review',
      suggestedScope: 'repo',
      status: 'proposed',
      sources: [],
      model: 'fast-model',
      costUsd: 0,
      createdAt: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-15T10:00:00.000Z',
    })
    const cases: [string, Action, { method?: string; body?: unknown }][] = [
      [`/api/jobs/${job.id}`, 'analyses:read', {}],
      [`/api/analyses/${analysis.id}`, 'analyses:read', {}],
      [`/api/audit-runs/${run.id}`, 'audits:read', {}],
      ['/api/learnings/l1/reject', 'knowledge:write', { method: 'POST', body: {} }],
    ]
    for (const [path, action, init] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of sequential requests
      const answer = await denied(app, path, 'reader', init)
      expect(answer.missing).toEqual({ action })
      expect(JSON.stringify(answer)).not.toContain('other/secret')
    }
  })

  test('a guide edit outside the caller scope names the repository scope only', async () => {
    const app = setup()
    expect(
      await denied(
        app,
        '/api/guide/section?scope=repo:work:acme/gadget&section=general',
        'writer',
        {
          method: 'PUT',
          body: { body: 'Use round widgets.' },
        },
      ),
    ).toEqual({
      error: 'missing permission knowledge:write',
      missing: { action: 'knowledge:write', target: 'work:acme/gadget' },
    })
  })

  test('a release step on a read-only repository names releases:run', async () => {
    const app = setup(async () => true)
    expect(
      await denied(app, '/api/releases/accept?repo=work:acme/gadget', 'admin', {
        method: 'DELETE',
      }),
    ).toEqual({
      error: 'acme/gadget is read-only for Holtkeeper',
      missing: { action: 'releases:run', target: 'work:acme/gadget' },
    })
  })
})

describe('MCP 403', () => {
  const toolset: RegistryToolset = {
    name: 'gadgets',
    tools: [
      defineTool({
        name: 'gadget_status',
        description: 'Status of a gadget',
        input: z.object({ repo: z.string() }),
        run: ({ repo }) => {
          if (repo === 'http') throw new ForbiddenException('analyses:read', 'work:acme/gadget')
          throw new ForbiddenToolError(`You may not read ${repo}.`, 'releases:read', repo)
        },
      }),
    ],
  }

  test('tool refusals carry the ForbiddenError body as structured content', async () => {
    const server = registryServer([toolset], {
      principal: { id: 'header:jane', name: 'Jane', provider: 'header', grants: [] },
      usage: { record: () => undefined },
      now: () => new Date('2026-11-16T00:00:00.000Z'),
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)

    const result = await client.callTool({
      name: 'gadget_status',
      arguments: { repo: 'work:acme/gadget' },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'You may not read work:acme/gadget.' }])
    expect(result.structuredContent).toEqual({
      error: 'You may not read work:acme/gadget.',
      missing: { action: 'releases:read', target: 'work:acme/gadget' },
    })

    const http = await client.callTool({ name: 'gadget_status', arguments: { repo: 'http' } })
    expect(http.structuredContent).toEqual({
      error: 'missing permission analyses:read',
      missing: { action: 'analyses:read', target: 'work:acme/gadget' },
    })
  })
})
