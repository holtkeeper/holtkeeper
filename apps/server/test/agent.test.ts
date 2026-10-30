import { beforeEach, describe, expect, test } from 'bun:test'

import type { Agent, AgentTask, ClaudeQuery, ModelCatalog } from '@holtkeeper/agent'
import { BudgetExceededError } from '@holtkeeper/ai-usage'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { KnowledgeEntryInput, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import {
  type AgentRunInfo,
  DEFAULT_KNOWLEDGE_TOKENS,
  findProviderCredential,
  settingsAgentFor,
  withServerDefaults,
} from '../src/agent.ts'

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return 'resolved'
}

type Options = NonNullable<Parameters<ClaudeQuery>[0]['options']>

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: { games: { forge: 'work', include: ['games/*'] } },
})
const repo = { forge: 'work', path: 'games/chess' }
const vault = aesVault('v'.repeat(32))
const now = () => new Date('2026-10-30T12:00:00.000Z')

const success = (cost = 0.01) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    num_turns: 2,
    total_cost_usd: cost,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }) as never

let store: Store
let calls: Options[]
let cost: number
const query: ClaudeQuery = async function* ({ options }) {
  calls.push(options ?? {})
  yield success(cost)
}

const knowledge = (overrides: Partial<KnowledgeEntryInput> = {}): KnowledgeEntryInput => ({
  id: 'k1',
  title: 'Use the chess engine facade',
  body: 'Never import the engine directly.',
  kind: 'convention',
  scope: { groups: ['games'] },
  topics: [],
  appliesTo: ['*'],
  status: 'accepted',
  evidence: [],
  source: 'human',
  author: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

async function setting(key: string, value: unknown, secret = false) {
  await store.settings.put({
    id: key,
    key,
    scope: { all: true },
    value: secret ? await vault.seal(JSON.stringify(value)) : value,
    secret,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
}

const appendOf = (options: Options) =>
  options.systemPrompt &&
  typeof options.systemPrompt === 'object' &&
  'append' in options.systemPrompt
    ? (options.systemPrompt.append ?? '')
    : ''

const listed: string[] = []
const catalog: ModelCatalog = {
  list: async (key) => {
    listed.push(key)
    return {
      models: ['claude-opus-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'].map((id) => ({
        id,
        source: 'provider' as const,
      })),
    }
  },
}

const agentFor = (log: string[] = []) =>
  settingsAgentFor({
    config,
    store,
    vault,
    now,
    log: (line) => log.push(line),
    agentOptions: { query },
    models: catalog,
  })

beforeEach(() => {
  store = memoryStore()
  listed.length = 0
  calls = []
  cost = 0.01
})

describe('settingsAgentFor', () => {
  test('no provider and no key: no agent', async () => {
    expect(await agentFor()(repo)).toBeUndefined()
  })

  test('llm.apiKey: Anthropic API with the default toolsets, knowledge context and recorded usage', async () => {
    await setting('llm.apiKey', 'sk-legacy', true)
    await setting('llm.model', 'claude-sonnet-5-5')
    await setting('llm.provider', 'anthropic')
    await store.knowledge.put(knowledge())
    await store.knowledge.put(
      knowledge({ id: 'k2', title: 'Other group', scope: { groups: ['tools'] } }),
    )

    const agent = await agentFor()(repo, { jobId: 'j1', analyzer: 'review' })
    const result = await agent?.run({
      dir: '/r',
      prompt: 'p',
      taskKind: 'review',
      context: 'Task notes',
    })
    expect(result?.text).toBe('ok')

    const [options] = calls
    expect(options?.env?.['ANTHROPIC_API_KEY']).toBe('sk-legacy')
    expect(options?.model).toBe('claude-sonnet-5-5')
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(['holtkeeper'])
    expect(options?.allowedTools).toContain('mcp__holtkeeper__code_search')
    expect(options?.allowedTools).toContain('mcp__holtkeeper__docs_package')
    expect(options?.allowedTools).toContain('mcp__holtkeeper__knowledge_search')
    const append = appendOf(options ?? {})
    expect(append).toContain('[kb:k1] Use the chess engine facade')
    expect(append).not.toContain('Other group')
    expect(append.indexOf('[kb:k1]')).toBeLessThan(append.indexOf('Task notes'))

    const [record] = await store.aiUsage.list()
    expect(record).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      taskKind: 'review',
      jobId: 'j1',
      analyzer: 'review',
      groups: ['games'],
      outcome: 'ok',
      costUsd: 0.01,
      inputTokens: 10,
    })
  })

  test('llm.provider names an AI provider credential by name; models and headers come from it', async () => {
    const credentials = createCredentialService({ credentials: store.credentials, vault })
    await credentials.create(
      {
        name: 'Corp gateway',
        kind: 'anthropic-compatible',
        url: 'https://llm.corp.test/anthropic',
        scope: { groups: ['games'] },
        secret: 'corp-token',
        options: {
          authHeader: 'bearer',
          headers: { 'X-Team': 'games' },
          modelMap: { 'claude-opus-5-5': 'corp-opus' },
        },
      },
      'u1',
    )
    await setting('llm.provider', 'Corp gateway')

    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p' })
    const env = calls[0]?.env ?? {}
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://llm.corp.test/anthropic')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('corp-token')
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Team: games')
    expect(calls[0]?.model).toBe('corp-opus')
    expect(await store.aiUsage.list()).toMatchObject([
      { provider: 'Corp gateway', model: 'corp-opus', taskKind: 'agent' },
    ])
  })

  test('@latest model references resolve against the provider listing', async () => {
    await setting('llm.apiKey', 'sk-test', true)
    await setting('llm.model', 'claude-opus@latest')
    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p' })
    expect(calls[0]?.model).toBe('claude-opus-5-5')
    expect(listed).toEqual(['settings:llm.apiKey:2026-10-01T00:00:00.000Z'])

    const log: string[] = []
    await setting('llm.model', 'gemini@latest')
    expect(await agentFor(log)(repo)).toBeUndefined()
    expect(log[0]).toContain('no listed model matches gemini@latest')
  })

  test('a provider that is missing, out of scope or invalid yields no agent and is logged', async () => {
    const log: string[] = []
    await setting('llm.provider', 'nope')
    expect(await agentFor(log)(repo)).toBeUndefined()
    await store.credentials.put({
      id: 'c1',
      name: 'Broken',
      kind: 'vertex',
      url: 'https://vertex.test',
      scope: { all: true },
      secret: await vault.seal('-'),
      options: { region: 'r' },
      createdAt: 'now',
      updatedAt: 'now',
    })
    await setting('llm.provider', 'c1')
    expect(await agentFor(log)(repo)).toBeUndefined()
    expect(log[0]).toContain('no AI provider credential "nope"')
    expect(log[1]).toContain('options.projectId')
  })

  test('a blocked budget denies the run and records it', async () => {
    await setting('llm.apiKey', 'sk', true)
    await setting('llm.budget', { monthlyUsd: 5, action: 'block' })
    cost = 6
    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    const denied = await agent
      ?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
      .catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(BudgetExceededError)
    expect(calls).toHaveLength(1)
    expect((await store.aiUsage.list()).map((record) => record.outcome).toSorted()).toEqual([
      'denied-budget',
      'ok',
    ])
  })

  test('agent.tools enables Context7 and sets the knowledge budget', async () => {
    await setting('llm.apiKey', 'sk', true)
    await setting('agent.tools', { context7: true, knowledgeTokens: 0 })
    await store.knowledge.put(knowledge())
    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p' })
    expect(Object.keys(calls[0]?.mcpServers ?? {}).toSorted()).toEqual(['context7', 'holtkeeper'])
    expect(appendOf(calls[0] ?? {})).not.toContain('[kb:k1]')
  })
})

describe('withServerDefaults', () => {
  const target = { ...repo, groups: ['games'] }

  test('reports results and errors to onRun; task toolsets of the same name win', async () => {
    const seen: AgentTask[] = []
    let fail = false
    const inner: Agent = {
      name: 'fake',
      async run(task) {
        seen.push(task)
        if (fail) throw new Error('boom')
        return { text: 'ok', turns: 1 }
      },
    }
    const infos: AgentRunInfo[] = []
    const agent = withServerDefaults(inner, {
      repo: target,
      store,
      now,
      onRun: (info) => {
        infos.push(info)
        throw new Error('recording failed')
      },
      onRunError: () => {},
    })
    const mine = { name: 'code', tools: [] }
    await agent.run({ dir: '/r', prompt: 'p', toolsets: [mine] })
    fail = true
    expect(await failure(agent.run({ dir: '/r', prompt: 'p', taskKind: 'tests' }))).toContain(
      'boom',
    )

    expect(seen[0]?.toolsets?.map((toolset) => toolset.name)).toEqual(['docs', 'knowledge', 'code'])
    expect(seen[0]?.toolsets?.at(-1)).toBe(mine)
    expect(seen[0]?.mcpServers).toBeUndefined()
    expect(
      infos.map((info) => [
        info.taskKind,
        info.provider,
        info.result?.text,
        info.error instanceof Error ? info.error.message : '',
      ]),
    ).toEqual([
      ['agent', 'fake', 'ok', ''],
      ['tests', 'fake', undefined, 'boom'],
    ])
    expect(DEFAULT_KNOWLEDGE_TOKENS).toBe(1500)
  })

  test('findProviderCredential prefers ids, then names, and skips other kinds and scopes', () => {
    const base = { url: 'https://x.test', secret: 's', createdAt: 'now', updatedAt: 'now' }
    const credentials = [
      { ...base, id: 'a', name: 'gw', kind: 'gitlab', scope: { all: true } },
      { ...base, id: 'b', name: 'gw', kind: 'openai-compatible', scope: { groups: ['tools'] } },
      { ...base, id: 'c', name: 'gw', kind: 'openai-compatible', scope: { all: true } },
      { ...base, id: 'gw', name: 'other', kind: 'anthropic', scope: { all: true } },
    ]
    expect(findProviderCredential(credentials, 'gw', target)?.id).toBe('gw')
    expect(findProviderCredential(credentials.slice(0, 3), 'gw', target)?.id).toBe('c')
    expect(findProviderCredential(credentials, 'a', target)).toBeUndefined()
  })
})
