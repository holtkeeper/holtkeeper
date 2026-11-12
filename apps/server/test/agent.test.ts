import { beforeEach, describe, expect, test } from 'bun:test'

import type { Action } from '@holtkeeper/access'
import type { Agent, AgentTask, ClaudeQuery, ModelCatalog } from '@holtkeeper/agent'
import { RESULT_CAPS } from '@holtkeeper/agent-tools'
import { BudgetDeniedError } from '@holtkeeper/ai-usage'
import { memoryArtifactStore } from '@holtkeeper/artifacts'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { KnowledgeEntryInput, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  type AgentRunInfo,
  DEFAULT_KNOWLEDGE_TOKENS,
  findProviderCredential,
  settingsAgentFor,
  withServerDefaults,
} from '../src/agent.ts'
import { createApiCatalog } from '../src/api-surface/catalog.ts'
import { createUsageIndex } from '../src/api-surface/usages.ts'
import { agentCatalogContext } from '../src/tools/registry.ts'
import { readTranscript } from '../src/transcripts.ts'

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

async function anthropic(secret: string) {
  const credentials = createCredentialService({ credentials: store.credentials, vault })
  const credential = await credentials.create({
    name: 'Anthropic',
    kind: 'anthropic',
    url: 'https://api.anthropic.com',
    scope: { all: true },
    secret,
  })
  await setting('llm.provider', 'Anthropic')
  return credential
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
      models: [
        'claude-haiku-5-5',
        'claude-opus-5-1',
        'claude-opus-5-5',
        'claude-sonnet-5',
        'claude-sonnet-5-5',
      ].map((id) => ({
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

  test('Anthropic API with the default toolsets, knowledge context and recorded usage', async () => {
    await anthropic('sk-anthropic')
    await store.knowledge.put(knowledge())
    await store.knowledge.put(
      knowledge({ id: 'k2', title: 'Other group', scope: { groups: ['tools'] } }),
    )

    const agent = await agentFor()(repo, { jobId: 'j1', analyzer: 'review' })
    const result = await agent?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    expect(result?.text).toBe('ok')

    const [options] = calls
    expect(options?.env?.['ANTHROPIC_API_KEY']).toBe('sk-anthropic')
    expect(options?.model).toBe('claude-sonnet-5-5')
    expect(options?.effort).toBe('medium')
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(['holtkeeper'])
    expect(options?.allowedTools).toContain('mcp__holtkeeper__code_search')
    expect(options?.allowedTools).toContain('mcp__holtkeeper__docs_package')
    expect(options?.allowedTools).toContain('mcp__holtkeeper__knowledge_search')
    expect(options?.allowedTools).toContain('mcp__holtkeeper__package_usage')
    expect(options?.allowedTools).toContain('mcp__holtkeeper__evaluate_dependency')
    const append = appendOf(options ?? {})
    expect(append).toContain('[kb:k1] Use the chess engine facade')
    expect(append).not.toContain('Other group')

    const [record] = await store.aiUsage.list()
    expect(record).toMatchObject({
      provider: 'Anthropic',
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

  test('a failed agent-loop probe runs tool loops on the AI SDK; every run stores a transcript', async () => {
    const credential = await anthropic('sk-ant-gizmo-0000000000000000')
    const stored = await store.credentials.get(credential.id)
    if (!stored) throw new Error('missing credential')
    await store.credentials.put({
      ...stored,
      capabilities: { agentLoop: 'failed', checkedAt: '2026-10-30T00:00:00.000Z' },
    })
    const artifacts = memoryArtifactStore()
    const agent = await settingsAgentFor({
      config,
      store,
      vault,
      now,
      artifacts,
      models: catalog,
      agentOptions: {
        query,
        languageModel: () =>
          new MockLanguageModelV4({
            doGenerate: {
              content: [{ type: 'text', text: 'fallback answer' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
              warnings: [],
            },
          }),
      },
    })(repo, { jobId: 'j9' })
    const result = await agent?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    expect(result).toMatchObject({ text: 'fallback answer', runtime: 'ai-sdk' })
    expect(calls).toEqual([])
    const [record] = await store.aiUsage.list({ jobId: 'j9' })
    expect(record?.transcriptRef).toBe(result?.transcriptRef)
    const lines = await readTranscript(artifacts, record?.transcriptRef ?? '')
    expect(lines?.map((line) => line.type)).toEqual(['start', 'assistant', 'end'])
    expect(lines?.[0]).toMatchObject({ runtime: 'ai-sdk', taskKind: 'review' })
    expect(JSON.stringify(lines)).not.toContain('sk-ant-gizmo')
    const info = await artifacts.stat(record?.transcriptRef ?? '')
    expect(info?.tags).toEqual({
      kind: 'transcript',
      repo: 'work:games/chess',
      taskKind: 'review',
      job: 'j9',
    })
  })

  test('llm.provider names an AI provider credential by name; headers and model names come from it', async () => {
    const credentials = createCredentialService({ credentials: store.credentials, vault })
    await credentials.create({
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
    })
    await setting('llm.provider', 'Corp gateway')

    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p', tier: 'deep' })
    const env = calls[0]?.env ?? {}
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://llm.corp.test/anthropic')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('corp-token')
    expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe('X-Team: games')
    expect(calls[0]?.model).toBe('corp-opus')
    expect(await store.aiUsage.list()).toMatchObject([
      { provider: 'Corp gateway', model: 'corp-opus', taskKind: 'agent' },
    ])
  })

  test('tiers resolve to the newest models the provider lists', async () => {
    const credential = await anthropic('sk-test')
    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p', tier: 'fast' })
    await agent?.run({ dir: '/r', prompt: 'p', tier: 'deep' })
    expect(calls.map((call) => [call.model, call.effort])).toEqual([
      ['claude-haiku-5-5', 'low'],
      ['claude-opus-5-5', 'high'],
    ])
    expect(listed).toEqual([`${credential.id}:${credential.updatedAt}`])

    const log: string[] = []
    const sparse = settingsAgentFor({
      config,
      store,
      vault,
      now,
      log: (line) => log.push(line),
      agentOptions: { query },
      models: { list: async () => ({ models: [{ id: 'other-model', source: 'provider' }] }) },
    })
    expect(await sparse(repo)).toBeUndefined()
    expect(log[0]).toContain('the provider lists no Claude model')

    const opusOnly = settingsAgentFor({
      config,
      store,
      vault,
      now,
      log: (line) => log.push(line),
      agentOptions: { query },
      models: { list: async () => ({ models: [{ id: 'claude-opus-5-5', source: 'provider' }] }) },
    })
    log.length = 0
    calls.length = 0
    await (await opusOnly(repo))?.run({ dir: '/r', prompt: 'p', tier: 'fast' })
    await (await opusOnly(repo))?.run({ dir: '/r', prompt: 'p', tier: 'fast' })
    expect(calls.map((call) => call.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(log).toEqual([
      'agent: provider "Anthropic": the provider lists no claude-haiku model, tier fast runs on deep (claude-opus-5-5)',
      'agent: provider "Anthropic": the provider lists no claude-sonnet model, tier main runs on deep (claude-opus-5-5)',
    ])
  })

  test('only the global llm.provider entry counts', async () => {
    await anthropic('sk')
    await store.settings.remove('llm.provider')
    await store.settings.put({
      id: 'group-provider',
      key: 'llm.provider',
      scope: { groups: ['games'] },
      value: 'Anthropic',
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(await agentFor()(repo)).toBeUndefined()
  })

  test('no provider, no agent', async () => {
    expect(await agentFor()(repo)).toBeUndefined()
  })

  test('a provider that is missing, out of scope or invalid yields no agent and is logged', async () => {
    const log: string[] = []
    await setting('llm.provider', 'nope')
    expect(await agentFor(log)(repo)).toBeUndefined()
    await store.credentials.put({
      id: 'c1',
      name: 'Broken',
      kind: 'anthropic-compatible',
      url: 'https://gw.test',
      scope: { all: true },
      secret: await vault.seal('-'),
      options: { authHeader: 'basic' },
      createdAt: 'now',
      updatedAt: 'now',
    })
    await setting('llm.provider', 'c1')
    expect(await agentFor(log)(repo)).toBeUndefined()
    expect(log[0]).toContain('no AI provider credential "nope"')
    expect(log[1]).toContain('options.authHeader')
  })

  test('the weekly budget caps runs, keeps the reserve for people and records denials', async () => {
    await anthropic('sk')
    await setting('llm.budget', { weeklyUsd: 10, reserveUsd: 4, action: 'block' })
    cost = 3
    const automatic = await agentFor()(repo, { jobId: 'j1' })
    await automatic?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    await automatic?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    const denied = await automatic
      ?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
      .catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(BudgetDeniedError)
    expect(calls.map((call) => call.maxBudgetUsd)).toEqual([6, 3])

    const person = await agentFor()(repo, { interactive: true })
    await person?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    expect(calls.map((call) => call.maxBudgetUsd)).toEqual([6, 3, 4])
    expect((await store.aiUsage.list()).map((record) => record.outcome).toSorted()).toEqual([
      'denied-budget',
      'ok',
      'ok',
      'ok',
    ])
  })

  test('a run keeps its subject on the stored usage record', async () => {
    await anthropic('sk')
    const agent = await agentFor()(repo, { jobId: 'j1', subject: 'MR !12' })
    await agent?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    expect((await store.aiUsage.list()).map((record) => record.subject)).toEqual(['MR !12'])
  })

  test('agent.tools sets the knowledge budget; no external MCP server is mounted', async () => {
    await anthropic('sk')
    await setting('agent.tools', { context7: true, knowledgeTokens: 0 })
    await store.knowledge.put(knowledge())
    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p' })
    expect(Object.keys(calls[0]?.mcpServers ?? {})).toEqual(['holtkeeper'])
    expect(appendOf(calls[0] ?? {})).not.toContain('[kb:k1]')
  })

  test('the Guide puts team rules before knowledge; a task with its own context keeps it', async () => {
    await anthropic('sk')
    await setting('knowledge.autoAccept', ['quirk'])
    await store.knowledge.put(knowledge())
    const rules = (
      scope: 'all' | `group:${string}`,
      section: 'general' | 'review' | 'releases',
      text: string,
    ) =>
      store.guides.put({
        scope,
        section,
        rules: text,
        steering: '',
        editedBy: 'u1',
        editedAt: '2026-10-01T00:00:00.000Z',
        learnings: [],
      })
    await rules('all', 'general', 'Answer in English.')
    await rules('group:games', 'review', 'Flag raw SQL.')
    await rules('group:games', 'releases', 'Keep public APIs.')
    const agent = await agentFor()(repo)
    await agent?.run({ dir: '/r', prompt: 'p', taskKind: 'review' })
    const append = appendOf(calls[0] ?? {})
    expect(append).toContain('Answer in English.')
    expect(append).toContain('Flag raw SQL.')
    expect(append).not.toContain('Keep public APIs.')
    expect(append.indexOf('Flag raw SQL.')).toBeLessThan(append.indexOf('Answer in English.'))
    expect(append.indexOf('Answer in English.')).toBeLessThan(append.indexOf('[kb:k1]'))

    await agent?.run({ dir: '/r', prompt: 'p', taskKind: 'review', context: 'Own guide' })
    const own = appendOf(calls[1] ?? {})
    expect(own).toContain('Own guide')
    expect(own).not.toContain('Flag raw SQL.')
    expect(own).not.toContain('[kb:k1]')
  })
})

describe('withServerDefaults', () => {
  const target = { ...repo, groups: ['games'] }

  test('adds the libraries toolset with the task repository', async () => {
    const seen: AgentTask[] = []
    const inner: Agent = {
      name: 'fake',
      async run(task) {
        seen.push(task)
        return { text: 'ok', turns: 1 }
      },
    }
    const asked: (string | undefined)[] = []
    const answer = async (_input: unknown, caller?: { repo?: string }) => {
      asked.push(caller?.repo)
      return 'zod@3.22.0'
    }
    const agent = withServerDefaults(inner, {
      repo: target,
      store,
      now,
      libraries: {
        versions: answer,
        search: answer,
        read: answer,
        changes: answer,
        issues: answer,
        source: answer,
      },
    })
    await agent.run({ dir: '/r', prompt: 'p' })
    const toolset = seen[0]?.toolsets?.find((item) => item.name === 'libraries')
    expect(toolset?.instructions).toContain('catalog tools')
    const versions = toolset?.tools.find((tool) => tool.name === 'libraries.versions')
    await versions?.run({ package: 'zod' }, { dir: '/r', signal: new AbortController().signal })
    expect(asked).toEqual([`${repo.forge}:${repo.path}`])
  })

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
    expect(seen[0]?.toolsets?.at(-1)).toEqual(mine)
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

  test('stores transcripts of successful and failed runs; a failing store never fails the run', async () => {
    let fail = false
    const inner: Agent = {
      name: 'fake',
      async run(task) {
        task.transcript?.write({ type: 'assistant', text: 'working' })
        if (fail) throw new Error('boom')
        return { text: 'ok', turns: 1 }
      },
    }
    const artifacts = memoryArtifactStore()
    const infos: AgentRunInfo[] = []
    const agent = withServerDefaults(inner, {
      repo: target,
      store,
      now,
      artifacts,
      origin: { jobId: 'j1' },
      onRun: (info) => {
        infos.push(info)
      },
    })
    const result = await agent.run({ dir: '/r', prompt: 'p' })
    expect(result.transcriptRef).toBeString()
    expect(infos[0]?.transcriptRef).toBe(result.transcriptRef)
    expect(await readTranscript(artifacts, result.transcriptRef ?? '')).toEqual([
      { at: now().toISOString(), type: 'assistant', text: 'working' },
    ])

    fail = true
    expect(await failure(agent.run({ dir: '/r', prompt: 'p' }))).toBe('boom')
    expect(infos[1]?.transcriptRef).toBe(result.transcriptRef)

    const errors: unknown[] = []
    const broken = withServerDefaults(inner, {
      repo: target,
      store,
      now,
      artifacts: {
        put: async () => {
          throw new Error('bucket down')
        },
      },
      onRunError: (error) => errors.push(error),
    })
    fail = false
    expect((await broken.run({ dir: '/r', prompt: 'p' })).transcriptRef).toBeUndefined()
    expect(String(errors[0])).toContain('bucket down')
  })

  test('reviews mount the catalog toolset; every tool result is capped', async () => {
    const seen: AgentTask[] = []
    const inner: Agent = {
      name: 'fake',
      async run(task) {
        seen.push(task)
        return { text: 'ok', turns: 1 }
      },
    }
    const agent = withServerDefaults(inner, {
      repo: target,
      store,
      now,
      catalog: agentCatalogContext({
        catalog: createApiCatalog({ analyses: store.analyses }),
        usages: createUsageIndex({ analyses: store.analyses }),
        store,
        repo: target,
        targetOf: (other) => ({ ...other, groups: [] }),
        policy: 'metadata',
        now,
      }),
    })
    const long = {
      name: 'gadgets',
      tools: [
        {
          name: 'gadgets.dump',
          description: 'A long answer',
          input: z.object({}),
          run: () => 'gadget\n'.repeat(10_000),
        },
      ],
    }
    await agent.run({ dir: '/r', prompt: 'p', taskKind: 'review', toolsets: [long] })
    await agent.run({ dir: '/r', prompt: 'p', taskKind: 'triage' })
    const [review, triage] = seen.map((task) => task.toolsets ?? [])
    expect(review?.map((toolset) => toolset.name)).toEqual([
      'code',
      'docs',
      'knowledge',
      'catalog',
      'stack',
      'gadgets',
    ])
    expect(triage?.map((toolset) => toolset.name)).toEqual(['code', 'docs', 'knowledge'])
    expect(review?.find((toolset) => toolset.name === 'catalog')?.instructions).toContain(
      'search_symbols',
    )

    const signal = new AbortController().signal
    const listPackages = review
      ?.find((toolset) => toolset.name === 'catalog')
      ?.tools.find((tool) => tool.name === 'list_packages')
    expect(await listPackages?.run({}, { dir: '/r', signal })).toBe('No package is indexed yet.')
    const dumped = await review?.at(-1)?.tools[0]?.run({}, { dir: '/r', signal })
    expect(dumped?.length).toBeLessThan(RESULT_CAPS.maxChars + 100)
    expect(dumped).toContain('output cut at about 4000 tokens')
  })

  test('autoAccept passes to the knowledge tools', async () => {
    const seen: AgentTask[] = []
    const inner: Agent = {
      name: 'fake',
      async run(task) {
        seen.push(task)
        return { text: 'ok', turns: 1 }
      },
    }
    const agent = withServerDefaults(inner, { repo: target, store, now, autoAccept: ['quirk'] })
    await agent.run({ dir: '/r', prompt: 'p', taskKind: 'tests' })
    const propose = seen[0]?.toolsets
      ?.find((toolset) => toolset.name === 'knowledge')
      ?.tools.find((tool) => tool.name === 'knowledge.propose')
    await propose?.run(
      { title: 'Flaky e2e on CI', body: 'Workaround: retry once.', kind: 'quirk' },
      { dir: '/r', signal: new AbortController().signal },
    )
    const [entry] = await store.knowledge.list({})
    expect(entry?.status).toBe('accepted')
  })

  test('runs for a person search knowledge only with their knowledge:read and never propose', async () => {
    const seen: AgentTask[] = []
    const inner: Agent = {
      name: 'fake',
      async run(task) {
        seen.push(task)
        return { text: 'ok', turns: 1 }
      },
    }
    const person = (actions: Action[]) =>
      withServerDefaults(inner, {
        repo: target,
        store,
        now,
        autoAccept: ['quirk'],
        requester: {
          id: 'header:kim',
          name: 'Kim',
          provider: 'header',
          grants: [{ scope: { all: true }, actions }],
        },
      })
    await person(['repos:read', 'knowledge:read']).run({
      dir: '/r',
      prompt: 'p',
      taskKind: 'tests',
    })
    await person(['repos:read']).run({ dir: '/r', prompt: 'p', taskKind: 'tests' })
    const [reader, outsider] = seen.map((task) =>
      task.toolsets?.find((toolset) => toolset.name === 'knowledge')?.tools.map((t) => t.name),
    )
    expect(reader).toEqual(['knowledge.search'])
    expect(outsider).toBeUndefined()
  })

  test('findProviderCredential prefers ids, then names, and skips other kinds and scopes', () => {
    const base = { url: 'https://x.test', secret: 's', createdAt: 'now', updatedAt: 'now' }
    const credentials = [
      { ...base, id: 'a', name: 'gw', kind: 'gitlab', scope: { all: true } },
      { ...base, id: 'b', name: 'gw', kind: 'ai-sdk', scope: { groups: ['tools'] } },
      { ...base, id: 'c', name: 'gw', kind: 'ai-sdk', scope: { all: true } },
      { ...base, id: 'd', name: 'gw', kind: 'openai-compatible', scope: { all: true } },
      { ...base, id: 'gw', name: 'other', kind: 'anthropic', scope: { all: true } },
    ]
    expect(findProviderCredential(credentials, 'gw', target)?.id).toBe('gw')
    expect(findProviderCredential(credentials.slice(0, 4), 'gw', target)?.id).toBe('c')
    expect(findProviderCredential(credentials.slice(3, 4), 'gw', target)).toBeUndefined()
    expect(findProviderCredential(credentials, 'a', target)).toBeUndefined()
  })
})
