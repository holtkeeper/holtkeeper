import { beforeEach, describe, expect, test } from 'bun:test'

import type { KnowledgeEmbeddingsStatus } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { type CredentialService, createCredentialService } from '@holtkeeper/credentials'
import type { Embedder } from '@holtkeeper/embed'
import { EmbeddingError } from '@holtkeeper/embed-openai'
import { type FakeEmbedder, createFakeEmbedder } from '@holtkeeper/embed/testing'
import { createGuideResolver } from '@holtkeeper/guide'
import { embeddingSubject, knowledgeAccess } from '@holtkeeper/knowledge'
import { DEFAULT_EMBEDDING_MODEL, builtinSettings } from '@holtkeeper/settings'
import type { KnowledgeEntryInput, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { semanticAccess } from '../src/agent.ts'
import { createApp } from '../src/app.ts'
import {
  type EmbedderInput,
  type KnowledgeEmbeddings,
  type KnowledgeEmbeddingsOptions,
  createKnowledgeEmbeddings,
  guideSemantic,
  watchKnowledgeWrites,
} from '../src/embeddings.ts'
import { createProbes } from '../src/health.ts'
import { searchKnowledge } from '../src/tools/knowledge.ts'

const at = '2026-11-12T12:00:00.000Z'
const now = () => new Date(at)
const repo = { forge: 'work', path: 'acme/shop-web', teams: ['web'] }

/**
 * A stand-in for a multilingual model: words of a made-up second language are read as their
 * English meaning before the fake embeds them, so a translated text lands on the original's vector
 * while sharing none of its words.
 */
const dictionary: Record<string, string> = {
  zorvi: 'retry',
  pakta: 'payment',
  wenlo: 'webhooks',
  dramu: 'with',
  kesto: 'backoff',
  tilvo: 'exponential',
  // English synonyms, for a reworded proposal.
  resend: 'retry',
  billing: 'payment',
  callbacks: 'webhooks',
  using: 'with',
  growing: 'exponential',
  delays: 'backoff',
}

const meaningOf = (text: string) =>
  text.replace(/[\p{L}]+/gu, (word) => dictionary[word.toLowerCase()] ?? word)

function multilingual(fake: FakeEmbedder): Embedder {
  return {
    get id() {
      return fake.id
    },
    model: fake.model,
    dimensions: fake.dimensions,
    embed: (texts, purpose, signal) => fake.embed(texts.map(meaningOf), purpose, signal),
  }
}

/** Titles of the made-up notes in the order a Guide text shows them. */
const order = (text: string) =>
  ['Name branches after tickets', 'Retry payment webhooks', 'Prefer small modules']
    .map((title) => ({ title, at: text.indexOf(title) }))
    .toSorted((a, b) => a.at - b.at)
    .map((item) => item.title)

const as = (role: string, init: RequestInit = {}) => ({
  ...init,
  headers: { 'x-forwarded-user': role, 'x-forwarded-groups': role },
})

const note = (id: string, overrides: Partial<KnowledgeEntryInput> = {}): KnowledgeEntryInput => ({
  id,
  title: 'Prefer small modules',
  body: 'Split files above three hundred lines.',
  kind: 'convention',
  scope: { all: true },
  topics: ['style'],
  appliesTo: ['*'],
  status: 'accepted',
  source: 'human',
  author: 'jane',
  evidence: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
})

let store: Store
let credentials: CredentialService
let fakes: Map<string, FakeEmbedder>
let built: EmbedderInput[]
let lines: string[]

const setting = (value: object) =>
  store.settings.put({
    id: 'embeddings',
    key: 'knowledge.embeddings',
    scope: { all: true },
    value,
    secret: false,
    updatedAt: at,
  })

const fakeFor = (model: string) => {
  let fake = fakes.get(model)
  if (!fake) {
    fake = createFakeEmbedder({ id: `fake:${model}@256` })
    fakes.set(model, fake)
  }
  return fake
}

const service = (options: Partial<KnowledgeEmbeddingsOptions> = {}): KnowledgeEmbeddings =>
  createKnowledgeEmbeddings({
    store,
    credentials,
    now,
    log: (line) => lines.push(line),
    createEmbedder: (input) => {
      built.push(input)
      return multilingual(fakeFor(input.model))
    },
    listModels: async () => [{ id: DEFAULT_EMBEDDING_MODEL, pricePerMillionTokens: 0.02 }],
    configCacheMs: 0,
    vectorCacheMs: 0,
    ...options,
  })

const subjects = async (model = `fake:${DEFAULT_EMBEDDING_MODEL}@256`) =>
  (await store.embeddings.list({ model, prefix: 'knowledge:' }))
    .map((row) => row.subject)
    .toSorted()

beforeEach(async () => {
  store = memoryStore()
  credentials = createCredentialService({
    credentials: store.credentials,
    vault: aesVault('v'.repeat(32)),
  })
  fakes = new Map()
  built = []
  lines = []
  await credentials.create({
    name: 'gateway',
    kind: 'ai-sdk',
    url: 'https://models.test/v1',
    scope: { all: true },
    secret: 'sk-made-up',
  })
  await store.settings.put({
    id: 'provider',
    key: 'llm.provider',
    scope: { all: true },
    value: 'gateway',
    secret: false,
    updatedAt: at,
  })
  await setting({ enabled: true })
  await store.knowledge.put(note('k1'))
  await store.knowledge.put(
    note('k2', {
      title: 'Retry payment webhooks',
      body: 'Retry payment webhooks with exponential backoff.',
      topics: ['payments'],
    }),
  )
})

describe('indexing', () => {
  test('is off until the setting enables it', async () => {
    await setting({ enabled: false })
    const embeddings = service()
    expect(await embeddings.index()).toEqual({ state: 'off', indexed: 0, total: 0 })
    expect(built).toEqual([])
    expect(await embeddings.semantic('anything')).toBeUndefined()
  })

  test('embeds every live note with the AI provider credential and reports ready', async () => {
    const embeddings = service()
    const status = await embeddings.index()
    expect(status).toMatchObject({
      state: 'ready',
      model: DEFAULT_EMBEDDING_MODEL,
      indexed: 2,
      total: 2,
      lastRunAt: at,
    })
    expect(built).toEqual([
      { url: 'https://models.test/v1', apiKey: 'sk-made-up', model: DEFAULT_EMBEDDING_MODEL },
    ])
    expect(await subjects()).toEqual([embeddingSubject('k1'), embeddingSubject('k2')])
    const fake = fakeFor(DEFAULT_EMBEDDING_MODEL)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.purpose).toBe('document')
    const usage = await store.aiUsage.list()
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      taskKind: 'embedding',
      actor: 'system',
      provider: 'gateway',
      model: DEFAULT_EMBEDDING_MODEL,
    })
    expect(usage[0]?.inputTokens).toBeGreaterThan(0)
    expect(usage[0]?.costUsd).toBeCloseTo(((usage[0]?.inputTokens ?? 0) * 0.02) / 1e6)
    expect(lines.join('\n')).not.toContain('sk-made-up')
  })

  test('re-embeds only the edited note and drops rejected ones', async () => {
    const embeddings = service()
    await embeddings.index()
    const fake = fakeFor(DEFAULT_EMBEDDING_MODEL)
    expect(await embeddings.index()).toMatchObject({ state: 'ready', indexed: 2 })
    expect(fake.calls).toHaveLength(1)

    await store.knowledge.put(note('k1', { body: 'Split files above two hundred lines.' }))
    await embeddings.index()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.texts).toHaveLength(1)
    expect(fake.calls[1]?.texts[0]).toContain('two hundred')

    const rejected = await store.knowledge.get('k2')
    if (!rejected) throw new Error('k2 missing')
    await store.knowledge.put({ ...rejected, status: 'rejected' })
    expect(await embeddings.index()).toMatchObject({ state: 'ready', indexed: 1, total: 1 })
    expect(await subjects()).toEqual([embeddingSubject('k1')])
    expect(fake.calls).toHaveLength(2)
  })

  test('a model change prunes the old vectors and embeds again', async () => {
    const embeddings = service()
    await embeddings.index()
    await setting({ enabled: true, model: 'acme/embed-large', dimensions: 256 })
    expect(await embeddings.status()).toMatchObject({ state: 'indexing', indexed: 0 })
    expect(await embeddings.index()).toMatchObject({
      state: 'ready',
      model: 'acme/embed-large',
      indexed: 2,
    })
    expect(built.at(-1)).toMatchObject({ model: 'acme/embed-large', dimensions: 256 })
    expect(await subjects()).toEqual([])
    expect(await subjects('fake:acme/embed-large@256')).toHaveLength(2)
    expect(fakeFor('acme/embed-large').calls).toHaveLength(1)
  })

  test('reindex drops every vector and embeds again', async () => {
    const embeddings = service()
    await embeddings.index()
    expect(await embeddings.reindex()).toMatchObject({ state: 'indexing', indexed: 0 })
    expect(await subjects()).toEqual([])
    expect(await embeddings.index()).toMatchObject({ state: 'ready', indexed: 2 })
    expect(fakeFor(DEFAULT_EMBEDDING_MODEL).calls).toHaveLength(2)
  })

  test('the leader duty indexes on start and after knowledge writes', async () => {
    const embeddings = service({ debounceMs: 5 })
    const watched = watchKnowledgeWrites(store, () => embeddings.touch())
    const stop = await embeddings.duty()
    try {
      await Bun.sleep(20)
      expect(await embeddings.status()).toMatchObject({ state: 'ready', indexed: 2 })
      await watched.knowledge.put(note('k3', { title: 'Name branches after tickets' }))
      await Bun.sleep(40)
      expect(await embeddings.status()).toMatchObject({ state: 'ready', indexed: 3, total: 3 })
      expect(fakeFor(DEFAULT_EMBEDDING_MODEL).calls.at(-1)?.texts).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  test('an exhausted budget makes no embedding call and leaves search full text', async () => {
    await store.settings.put({
      id: 'budget',
      key: 'llm.budget',
      scope: { all: true },
      value: { weeklyUsd: 1, reserveUsd: 0 },
      secret: false,
      updatedAt: at,
    })
    await store.aiUsage.append({
      at: '2026-11-10T09:00:00.000Z',
      repo: { forge: 'work', path: 'acme/shop-web' },
      teams: ['web'],
      taskKind: 'review',
      actor: 'system',
      provider: 'gateway',
      model: 'model-main',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 5,
      costSource: 'reported',
      durationMs: 1000,
      turns: 1,
      outcome: 'ok',
    })
    const embeddings = service()
    const status = await embeddings.index()
    expect(status.state).toBe('error')
    expect(status.error).toContain('budget')
    expect(await embeddings.semantic('retry webhooks')).toBeUndefined()
    expect(fakeFor(DEFAULT_EMBEDDING_MODEL).calls).toEqual([])
  })

  test('errors show in the status, are logged once and leave search working', async () => {
    let failures = 0
    const embeddings = service({
      createEmbedder: () => ({
        id: 'broken:model@8',
        model: 'model',
        dimensions: 8,
        embed: async () => {
          failures += 1
          throw new EmbeddingError(503, 'the endpoint is down', 'unavailable')
        },
      }),
    })
    const status = await embeddings.index()
    expect(status).toMatchObject({ state: 'error', error: 'the endpoint is down (HTTP 503)' })
    await embeddings.index()
    expect(lines.filter((line) => line.includes('endpoint is down'))).toHaveLength(1)
    expect(await embeddings.semantic('retry webhooks')).toBeUndefined()

    const access = knowledgeAccess({ store, now, ...semanticAccess(embeddings) })
    const hits = await access.search('payment webhooks', { repo, taskKind: 'review' })
    expect(hits.map((hit) => hit.id)).toEqual(['k2'])
    expect(failures).toBeGreaterThan(1)
  })

  test('a credential of another kind is an error, not a crash', async () => {
    await credentials.create({
      name: 'chat-only',
      kind: 'anthropic',
      url: 'https://chat.test',
      scope: { all: true },
      secret: 'sk-other',
    })
    await setting({ enabled: true, credential: 'chat-only' })
    const embeddings = service()
    const status = await embeddings.index()
    expect(status.state).toBe('error')
    expect(status.error).toContain('ai-sdk')
    expect(built).toEqual([])
  })
})

describe('semantic ranking', () => {
  test('a query in another language reorders the Guide notes', async () => {
    // k3 is the newest, so text relevance alone (no shared word) puts it first.
    await store.knowledge.put(
      note('k3', {
        title: 'Name branches after tickets',
        body: 'Branch names start with the ticket key.',
        updatedAt: '2026-11-05T00:00:00.000Z',
      }),
    )
    const embeddings = service()
    await embeddings.index()
    const query = 'Zorvi pakta wenlo dramu tilvo kesto'
    const resolve = createGuideResolver({ store })

    const plain = await resolve({ repo, task: 'review', query })
    expect(order(plain.text)[0]).toBe('Name branches after tickets')

    const semantic = await guideSemantic(embeddings, store, repo, query)
    expect(semantic?.get('k2')).toBeGreaterThan(0.8)
    const ranked = await resolve({ repo, task: 'review', query, ...(semantic && { semantic }) })
    expect(order(ranked.text)[0]).toBe('Retry payment webhooks')
  })

  test('only candidates are compared, and queries are cached', async () => {
    const embeddings = service()
    await embeddings.index()
    const fake = fakeFor(DEFAULT_EMBEDDING_MODEL)
    const cosines = await embeddings.semantic('pakta wenlo', ['k2'])
    expect([...(cosines?.keys() ?? [])]).toEqual(['k2'])
    await embeddings.semantic('pakta wenlo', ['k1', 'k2'])
    expect(fake.calls.filter((call) => call.purpose === 'query')).toHaveLength(1)
    await embeddings.flush()
    const usage = await store.aiUsage.list()
    expect(usage.map((record) => record.subject)).toContain('1 query')
  })

  test('search finds a note by meaning alone', async () => {
    const embeddings = service()
    await embeddings.index()
    const access = knowledgeAccess({ store, now, ...semanticAccess(embeddings) })
    const hits = await access.search('zorvi pakta wenlo', { repo, taskKind: 'review' })
    expect(hits.map((hit) => hit.id)).toEqual(['k2'])
  })

  test('the MCP knowledge search finds a note by meaning and words alone without vectors', async () => {
    const embeddings = service()
    await embeddings.index()
    const context = {
      store,
      canReadScope: () => true,
      repoOf: () => undefined,
      actor: 'agent',
      now,
    }
    const query = { query: 'zorvi pakta wenlo' }
    expect(await searchKnowledge(context, query)).not.toContain('Retry payment webhooks')
    expect(await searchKnowledge({ ...context, semantics: embeddings }, query)).toContain(
      'Retry payment webhooks',
    )
  })

  test('a reworded proposal is a duplicate from a cosine of 0.9', async () => {
    const embeddings = service()
    await embeddings.index()
    const proposal = {
      title: 'Resend billing callbacks',
      body: 'Resend billing callbacks using growing delays.',
      topics: ['payments'],
    }
    const plain = knowledgeAccess({ store, now })
    const ctx = { actor: 'agent', repo, taskKind: 'review' }
    const deduped = await knowledgeAccess({ store, now, ...semanticAccess(embeddings) }).propose(
      proposal,
      ctx,
    )
    expect(deduped.duplicateOf).toBe('k2')
    const created = await plain.propose(proposal, ctx)
    expect(created.duplicateOf).toBeUndefined()
  })
})

describe('routes', () => {
  const config = parseConfig({
    forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
    teams: { web: { owns: ['work:acme/*-web'] } },
  })
  const auth = headerAuth({
    roles: {
      admin: [{ scope: { all: true }, actions: ['*'] }],
      reader: [{ scope: { teams: ['web'] }, actions: ['knowledge:read'] }],
      'web-owner': [{ scope: { teams: ['web'] }, actions: ['knowledge:read', 'settings:write'] }],
      outsider: [{ scope: { teams: ['web'] }, actions: ['repos:read'] }],
    },
  })
  const appOf = (embeddings?: KnowledgeEmbeddings) => {
    const vault = aesVault('v'.repeat(32))
    return createApp({
      config,
      auth,
      store,
      vault,
      credentials,
      settings: builtinSettings,
      analyses: [],
      now,
      ...(embeddings && { embeddings }),
    })
  }

  test('status needs knowledge:read somewhere', async () => {
    const embeddings = service()
    await embeddings.index()
    const app = appOf(embeddings)
    const response = await app.request('/api/knowledge/embeddings', as('reader'))
    expect(response.status).toBe(200)
    expect((await response.json()) as KnowledgeEmbeddingsStatus).toMatchObject({
      state: 'ready',
      indexed: 2,
      total: 2,
    })
    expect((await app.request('/api/knowledge/embeddings', as('outsider'))).status).toBe(403)
    const off = await appOf().request('/api/knowledge/embeddings', as('reader'))
    expect(await off.json()).toEqual({ state: 'off', indexed: 0, total: 0 })
  })

  test('models and reindex need a global settings:write', async () => {
    const embeddings = service()
    await embeddings.index()
    const app = appOf(embeddings)
    expect((await app.request('/api/knowledge/embeddings/models', as('web-owner'))).status).toBe(
      403,
    )
    const models = await app.request('/api/knowledge/embeddings/models', as('admin'))
    expect(await models.json()).toMatchObject({
      credential: { name: 'gateway' },
      models: [{ id: DEFAULT_EMBEDDING_MODEL, pricePerMillionTokens: 0.02 }],
    })
    const missing = await app.request(
      '/api/knowledge/embeddings/models?credential=nope',
      as('admin'),
    )
    expect(await missing.json()).toEqual({ models: [], error: 'credential "nope" does not exist' })

    const forbidden = await app.request(
      '/api/knowledge/embeddings/reindex',
      as('web-owner', { method: 'POST' }),
    )
    expect(forbidden.status).toBe(403)
    const reindex = await app.request(
      '/api/knowledge/embeddings/reindex',
      as('admin', { method: 'POST' }),
    )
    expect(reindex.status).toBe(200)
    expect(await reindex.json()).toMatchObject({ state: 'indexing' })
    expect(await subjects()).toEqual([])
    const audit = await store.audit.list()
    expect(audit.events.map((event) => event.action)).toContain('knowledge.reindex')
  })

  test('/readyz reports the state of semantic search but stays green on an error', async () => {
    await setting({ enabled: true, credential: 'missing' })
    const embeddings = service()
    const probes = createProbes({
      store,
      draining: () => false,
      info: { embeddings: async () => (await embeddings.status()).state },
    })
    const response = await probes.ready()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', info: { embeddings: 'error' } })
  })
})
