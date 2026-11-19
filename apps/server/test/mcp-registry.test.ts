import { describe, expect, test } from 'bun:test'

import type { RepoTarget } from '@holtkeeper/access'
import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import { assetsPolicySchema } from '@holtkeeper/assets'
import { parseConfig } from '@holtkeeper/core'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { TestIdsData } from '@holtkeeper/testids'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'

import { createApiCatalog } from '../src/api-surface/catalog.ts'
import { registryServer } from '../src/api-surface/mcp.ts'
import type { McpCall } from '../src/api-surface/usage.ts'
import { createUsageIndex } from '../src/api-surface/usages.ts'
import { createRulesResolver, readForgeRuleFiles } from '../src/rules.ts'
import { assetsToolset } from '../src/tools/assets.ts'
import { knowledgeToolset } from '../src/tools/knowledge.ts'
import { type QaToolsAccess, qaToolset } from '../src/tools/qa.ts'
import {
  agentRulesAccess,
  mcpToolsets,
  repoRulesAccess,
  taskToolsets,
} from '../src/tools/registry.ts'
import {
  type RulesAccess,
  type RulesToolsetOptions,
  rulesToolset,
  testIdsReader,
} from '../src/tools/rules.ts'

const now = () => new Date('2026-11-01T10:00:00.000Z')
const principal = { id: 'header:sam', name: 'Sam', provider: 'header', grants: [] }

const kiteFiles: Record<string, string> = {
  'AGENTS.md': 'Kites are drawn with the shared canvas.',
  'src/tails/AGENTS.md': 'Tails are always optional.',
  '.cursor/rules/colors.mdc':
    '---\ndescription: How kite colors are named\n---\nColors come from the palette module.',
}

const forgeConfig = parseConfig({
  forges: {
    work: {
      kind: 'fake',
      url: 'https://forge.test',
      create: () =>
        ({
          listFiles: async (repo: string) =>
            repo === 'toys/kite'
              ? Object.keys(kiteFiles).map((path) => ({ path, type: 'file' }))
              : [],
          readFile: async (repo: string, path: string) =>
            repo === 'toys/kite' ? kiteFiles[path] : undefined,
        }) as never,
    },
  },
  teams: { toys: { owns: ['work:toys/*'] }, barns: { owns: ['work:barns/*'] } },
})

const knowledgeOf = (store: Store) => ({
  store,
  config: forgeConfig,
  canReadScope: () => true,
  repoOf: () => undefined,
  actor: 'header:sam',
  now,
})

const widgets = {
  name: 'widgets',
  instructions: 'Widgets are listed by list_widgets.',
  tools: [
    defineTool({
      name: 'list_widgets',
      description: 'Lists widgets',
      input: z.object({ shape: z.string().describe('Shape of the widgets') }),
      run: ({ shape }) => {
        if (shape === 'none') throw new ToolError('No widget has that shape.')
        if (shape === 'boom') throw new Error('disk full')
        return shape === 'huge' ? 'w\n'.repeat(50_000) : `${shape} widget`
      },
      subject: ({ shape }) => shape,
    }),
    defineTool({
      name: 'add_widget',
      description: 'Adds a widget',
      input: z.object({ name: z.string() }),
      readOnly: false,
      run: ({ name }) => `added ${name}`,
    }),
  ],
}

async function connect(calls: McpCall[], toolsets: readonly RegistryToolset[] = [widgets]) {
  const server = registryServer(toolsets, {
    principal,
    client: 'widget-cli/1.0',
    usage: { record: (call) => void calls.push(call) },
    now,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return client
}

const none = async () => undefined

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { text: string }[])[0]?.text ?? ''

describe('registryServer', () => {
  test('lists toolset tools with their schemas, annotations and instructions', async () => {
    const client = await connect([])
    expect(client.getInstructions()).toBe('Widgets are listed by list_widgets.')
    const { tools } = await client.listTools()
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ['list_widgets', true],
      ['add_widget', false],
    ])
    expect(tools[0]?.inputSchema.properties).toEqual({
      shape: { type: 'string', description: 'Shape of the widgets' },
    })
  })

  test('runs tools, reports errors and records every call', async () => {
    const calls: McpCall[] = []
    const client = await connect(calls)
    expect(
      textOf(await client.callTool({ name: 'list_widgets', arguments: { shape: 'round' } })),
    ).toBe('round widget')
    const missing = await client.callTool({ name: 'list_widgets', arguments: { shape: 'none' } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe('No widget has that shape.')
    const failed = await client.callTool({ name: 'list_widgets', arguments: { shape: 'boom' } })
    expect(textOf(failed)).toBe('Failed: disk full')
    const huge = textOf(
      await client.callTool({ name: 'list_widgets', arguments: { shape: 'huge' } }),
    )
    expect(huge.length).toBeLessThan(80_200)
    expect(huge).toContain('output cut at about 20000 tokens')
    await client.callTool({ name: 'add_widget', arguments: { name: 'cog' } })

    expect(calls.map((call) => [call.tool, call.subject, call.ok, call.client])).toEqual([
      ['list_widgets', 'round', true, 'widget-cli/1.0'],
      ['list_widgets', 'none', false, 'widget-cli/1.0'],
      ['list_widgets', 'boom', false, 'widget-cli/1.0'],
      ['list_widgets', 'huge', true, 'widget-cli/1.0'],
      ['add_widget', undefined, true, 'widget-cli/1.0'],
    ])
    expect(calls[0]).toMatchObject({ principal: 'header:sam', at: now().toISOString() })
  })
})

describe('mcpToolsets', () => {
  const store = memoryStore()
  const base = {
    catalog: createApiCatalog({ analyses: store.analyses }),
    usages: createUsageIndex({ analyses: store.analyses }),
    store,
    knowledge: knowledgeOf(store),
    canRead: () => true,
    canReadAnalyses: () => true,
    canReadAudits: () => true,
  }

  test('serves packages and knowledge, and rules only with a rules part', () => {
    expect(mcpToolsets(base).map((toolset) => toolset.name)).toEqual(['packages', 'knowledge'])
    const withRules = mcpToolsets({ ...base, commits: { conventions: async () => undefined } })
    expect(withRules.map((toolset) => toolset.name)).toEqual(['packages', 'knowledge', 'rules'])
    expect(withRules.flatMap((toolset) => toolset.tools.map((tool) => tool.name))).toEqual([
      'find_packages',
      'package_api',
      'package_changes',
      'package_usage',
      'evaluate_dependency',
      'search_knowledge',
      'propose_learning',
      'repo_rules',
      'check_commit_message',
    ])
  })

  test('rules fold conventions into repo_rules topics and leave reading a rule to search_knowledge', () => {
    const toolsets = mcpToolsets({
      ...base,
      rules: { resolve: none, rule: none, learning: none, repoFile: none },
      commits: { conventions: async () => undefined },
      testIds: { testIds: async () => undefined },
      assets: { policy: none, assets: none },
    })
    const rules = toolsets.find((toolset) => toolset.name === 'rules')
    expect(rules?.tools.map((tool) => [tool.name, tool.readOnly ?? true])).toEqual([
      ['repo_rules', true],
      ['check_commit_message', true],
      ['test_ids', true],
    ])
    expect(rules?.instructions).toStartWith('Call repo_rules')
    expect(rules?.instructions).toContain('`topics`')
    expect(rules?.instructions).not.toContain('get_rule')
    const repoRules = rules?.tools.find((tool) => tool.name === 'repo_rules')
    expect(repoRules?.description).toContain('search_knowledge (pass `id`)')
    expect(
      repoRules?.input.safeParse({ repo: 'work:toys/kite', topics: ['commits', 'test-ids'] })
        .success,
    ).toBe(true)
    expect(
      repoRules?.input.safeParse({ repo: 'work:toys/kite', topics: ['releases'] }).success,
    ).toBe(false)
    const search = toolsets
      .find((toolset) => toolset.name === 'knowledge')
      ?.tools.find((tool) => tool.name === 'search_knowledge')
    expect(Object.keys(search?.input.shape ?? {})).toEqual(['query', 'id', 'repo', 'limit'])
    expect(toolsets.find((toolset) => toolset.name === 'assets')?.tools.map((t) => t.name)).toEqual(
      ['repo_assets'],
    )
  })

  test('without a rules reader search_knowledge takes no id', () => {
    const search = mcpToolsets(base)
      .find((toolset) => toolset.name === 'knowledge')
      ?.tools.find((tool) => tool.name === 'search_knowledge')
    expect(Object.keys(search?.input.shape ?? {})).toEqual(['query', 'repo', 'limit'])
  })

  test('ask is offered only with an ask access and to tokens that kept it on', () => {
    const ask = { ask: async () => 'answer' }
    expect(mcpToolsets({ ...base, ask }).map((toolset) => toolset.name)).toEqual([
      'packages',
      'knowledge',
      'ask',
    ])
    expect(
      mcpToolsets({ ...base, ask, toolsets: ['packages'] }).map((toolset) => toolset.name),
    ).toEqual(['packages'])
  })

  test('offers no write tools besides learning proposals, and no fleet, ops or release state', () => {
    const toolsets = mcpToolsets({
      ...base,
      rules: { resolve: none, rule: none, learning: none, repoFile: none },
      releases: {
        repoOf: () => undefined,
        settings: async () => ({}),
        rules: async () => '',
        status: async () => ({}),
        changes: async () => ({}),
        steps: { preview: async () => ({}), run: async () => ({}) },
      },
      reviews: { status: async () => ({}), review: async () => ({}) },
      stack: { views: async () => [], ownerOf: () => [] },
      ops: {},
      tasks: {},
    } as never)
    expect(toolsets.map((toolset) => toolset.name)).toEqual([
      'packages',
      'knowledge',
      'rules',
      'reviews',
    ])
    const tools = toolsets.flatMap((toolset) => toolset.tools)
    expect(tools.filter((tool) => tool.readOnly === false).map((tool) => tool.name)).toEqual([
      'propose_learning',
      'code_review',
    ])
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain('repo_stack')
    expect(names).toContain('code_review')
    expect(
      toolsets
        .find((toolset) => toolset.name === 'rules')
        ?.tools.find((tool) => tool.name === 'repo_rules')
        ?.input.safeParse({ repo: 'work:toys/kite', topics: ['releases'] }).success,
    ).toBe(true)
    for (const name of [
      'release_rules',
      'get_rule',
      'stack_usage',
      'release_status',
      'release_step',
      'start_task',
      'jobs',
    ])
      expect(names).not.toContain(name)
  })

  test('internal tasks mount packages everywhere but one-shots, a checkout-free set for chat and ask', () => {
    expect(taskToolsets('review')).toEqual([
      'code',
      'docs',
      'knowledge',
      'packages',
      'git',
      'stack',
      'assets',
    ])
    expect(taskToolsets('rule-miner')).toEqual([])
    expect(taskToolsets('release-notes')).toEqual([])
    expect(taskToolsets('library-digest')).toEqual([])
    expect(taskToolsets('chat')).toEqual([
      'knowledge',
      'packages',
      'stack',
      'rules',
      'assets',
      'releases',
      'ops',
    ])
    expect(taskToolsets('ask')).toEqual(['knowledge', 'packages', 'stack', 'rules', 'assets'])
    expect(taskToolsets('chat-summary')).toEqual([])
    expect(taskToolsets('triage')).toEqual(['code', 'docs', 'knowledge', 'packages'])
    expect(taskToolsets('agent')).not.toContain('stack')
  })
})

const shapes = { forge: 'work', path: 'shapes/app' }

const qaAccess: QaToolsAccess = {
  tasks: async () => ({
    tasks: [
      {
        key: 'ABC-1',
        title: 'Round the widget corners',
        repos: [shapes],
        teams: ['toys'],
        lastAt: '2026-10-30T10:00:00.000Z',
        counts: { merged: 1, open: 0, direct: 1 },
        authors: ['Sam'],
        summary: 'stale',
      },
      {
        key: 'ABC-2',
        title: 'Draft saving',
        repos: [shapes],
        teams: ['toys'],
        lastAt: '2026-10-29T10:00:00.000Z',
        counts: { merged: 0, open: 1, direct: 0 },
        authors: ['Kim'],
      },
    ],
    days: 30,
    untracked: 3,
    repos: { listed: 2, read: 1, pending: 1, failed: [] },
  }),
  task: async (key) => {
    if (key !== 'ABC-1') throw new ToolError(`No change names ${key}.`)
    return {
      key,
      title: 'Round the widget corners',
      url: 'https://tracker.example/ABC-1',
      repos: [shapes],
      pending: 0,
      can: { summarize: false },
      changes: [
        {
          repo: shapes,
          kind: 'commit',
          id: 'abc12345',
          branch: 'main',
          title: 'ABC-1 fix corner radius',
          at: '2026-10-30T10:00:00.000Z',
          authors: ['Sam'],
          keys: ['ABC-1'],
          commits: ['abc12345'],
          head: 'abc12345',
          detail: {
            files: [{ path: 'src/Widget.tsx', status: 'modified', additions: 3, deletions: 1 }],
            testIds: [
              {
                file: 'src/Widget.tsx',
                added: [{ attribute: 'data-testid', value: 'widget-panel' }],
                removed: [],
              },
            ],
          },
        },
      ],
      summary: {
        sections: {
          overview: 'Widgets get round corners.',
          changes: ['Corners are round.'],
          verdict: 'should',
          verdictReason: 'Visible change.',
          testCases: [
            {
              title: 'Corners',
              priority: 'medium',
              steps: ['Open a widget'],
              expected: 'Corners are round',
            },
          ],
          testing: [{ kind: 'visual', ideas: ['Compare screenshots.'] }],
          autotests: [{ level: 'e2e', idea: 'Check the panel.', testIds: ['widget-panel'] }],
          risks: ['Shared styles.'],
          questions: [],
        },
        at: '2026-10-30T11:00:00.000Z',
        by: { id: 'header:kim', name: 'Kim' },
        repos: ['work:shapes/app'],
        changes: 1,
        stale: { added: ['work:shapes/app@def67890'], removed: [], updated: [] },
      },
    }
  },
}

const qaTool = (name: string) => qaToolset(qaAccess).tools.find((each) => each.name === name)!
const run = (name: string, input: Record<string, unknown>) =>
  qaTool(name).run(qaTool(name).input.parse(input), {
    dir: '.',
    signal: new AbortController().signal,
  })

describe('qa toolset', () => {
  test('is offered to signed-in readers and to tokens that turned it on', () => {
    const base = {
      catalog: createApiCatalog({ analyses: memoryStore().analyses }),
      usages: createUsageIndex({ analyses: memoryStore().analyses }),
      store: memoryStore(),
      knowledge: knowledgeOf(memoryStore()),
      canRead: () => true,
      canReadAnalyses: () => true,
      canReadAudits: () => true,
      qa: qaAccess,
    }
    expect(mcpToolsets(base).map((toolset) => toolset.name)).toEqual([
      'packages',
      'knowledge',
      'qa',
    ])
    expect(mcpToolsets({ ...base, toolsets: ['qa'] }).map((toolset) => toolset.name)).toEqual([
      'qa',
    ])
    expect(mcpToolsets({ ...base, toolsets: ['packages'] }).map((toolset) => toolset.name)).toEqual(
      ['packages'],
    )
    expect(qaToolset(qaAccess).tools.every((each) => each.readOnly !== false)).toBe(true)
  })

  test('qa_tasks lists tasks with counts, notes state, pending reads and untracked changes', async () => {
    const text = await run('qa_tasks', { query: 'widget' })
    expect(text).toContain('## QA tasks of the last 30 days (1)')
    expect(text).toContain('1 of 2 repositories are still being read')
    expect(text).toContain(
      '- **ABC-1** Round the widget corners — work:shapes/app · 1 merged, 1 direct · last 2026-10-30T10:00:00.000Z · test notes outdated',
    )
    expect(text).not.toContain('ABC-2')
    expect(text).toContain('3 changes name no task')
  })

  test('qa_task shows changes per repository, test ids and the stored notes', async () => {
    const text = await run('qa_task', { key: 'ABC-1' })
    expect(text).toContain('### work:shapes/app')
    expect(text).toContain('**abc12345** ABC-1 fix corner radius (direct commit, no review)')
    expect(text).toContain('`src/Widget.tsx` +3/−1')
    expect(text).toContain('+`data-testid=widget-panel`')
    expect(text).toContain('**Outdated:** 1 new, 0 updated, 0 gone')
    expect(text).toContain('e2e: Check the panel. (`widget-panel`)')
    expect(Promise.resolve(run('qa_task', { key: 'ABC-9' }))).rejects.toThrow(
      'No change names ABC-9.',
    )
  })
})

const target = (value: string): RepoTarget | undefined =>
  value.startsWith('work:toys/')
    ? { forge: 'work', path: value.slice('work:'.length), teams: ['toys'] }
    : undefined

describe('rules toolset', () => {
  const catalog: TestIdsData = {
    attributes: ['data-qa'],
    components: [
      {
        name: 'WidgetCard',
        file: 'src/WidgetCard.tsx',
        source: 'jsx',
        total: 2,
        elements: [
          { line: 4, tag: 'button', attributes: [{ name: 'data-qa', value: 'widget-card-save' }] },
          { line: 9, tag: 'input', attributes: [{ name: 'data-qa', value: 'widget-card-title' }] },
        ],
      },
      {
        name: 'ShapeList',
        file: 'src/shapes/ShapeList.tsx',
        source: 'jsx',
        total: 1,
        elements: [
          { line: 2, tag: 'a', attributes: [{ name: 'data-qa', value: 'shape-list-more' }] },
        ],
      },
    ],
  }

  async function setup(options: RulesToolsetOptions = {}) {
    const store = memoryStore()
    await store.rules.put({
      id: 'r-fetch',
      title: 'Data fetching',
      body: 'Widgets never fetch data themselves.',
      scope: { teams: ['toys'] },
      author: 'sam',
      createdAt: '2026-10-31T08:00:00.000Z',
      updatedAt: '2026-10-31T08:00:00.000Z',
    })
    await store.analyses.add({
      repo: { forge: 'work', path: 'toys/kite' },
      kind: 'testids',
      sha: 'abcdef1234567890',
      createdAt: '2026-10-31T08:00:00.000Z',
      data: catalog,
    })
    await store.settings.put({
      id: 's1',
      key: 'analyzers.testids',
      scope: { repos: ['work:toys/kite'] },
      value: { exclude: ['src/legacy/**'] },
      secret: false,
      updatedAt: '2026-10-31T08:00:00.000Z',
    })
    const resolve = createRulesResolver({ store, config: forgeConfig, now })
    const repoFiles = (repo: RepoTarget) =>
      readForgeRuleFiles({
        forge: forgeConfig.forges.work!.create(),
        forgeId: repo.forge,
        repo: repo.path,
      })
    const testIds = testIdsReader({ store })
    const access: RulesAccess = {
      rules: repoRulesAccess({
        store,
        resolve,
        repoFiles,
        readable: target,
        canReadScope: (scope) => !scope.teams?.includes('sheds'),
      }),
      testIds: {
        testIds: async (value) => {
          const repo = target(value)
          return repo ? testIds(repo) : undefined
        },
      },
      assets: {
        policy: async (value) =>
          target(value)
            ? { policy: assetsPolicySchema.parse({}), source: { level: 'default' } }
            : undefined,
        assets: none,
      },
    }
    const rules = rulesToolset(access, options)
    if (!rules) throw new Error('no rules toolset')
    const knowledge = knowledgeToolset(
      {
        ...knowledgeOf(store),
        repoOf: target,
        canReadScope: (scope) => !scope.teams?.includes('sheds'),
      },
      options.reader === false ? access.rules : undefined,
    )
    const calls: McpCall[] = []
    return {
      store,
      client: await connect(calls, [rules, knowledge]),
      calls,
      resolve,
      repoFiles,
      access,
    }
  }

  test('repo_rules resolves panel rules, nested rules files and requested rules of readable repositories only', async () => {
    const { client } = await setup()
    expect(client.getInstructions()).toContain('Call repo_rules')
    const all = textOf(
      await client.callTool({ name: 'repo_rules', arguments: { repo: 'work:toys/kite' } }),
    )
    expect(all).toStartWith('# Rules for `work:toys/kite`')
    expect(all).toContain('### Data fetching [rule:r-fetch]\nWidgets never fetch data themselves.')
    expect(all).toContain('Kites are drawn with the shared canvas.')
    expect(all).toContain('Tails are always optional.')
    expect(all).toContain('- `.cursor/rules/colors.mdc`: How kite colors are named')
    expect(all).toContain('Blocks, strongest first:')
    const scoped = textOf(
      await client.callTool({
        name: 'repo_rules',
        arguments: { repo: 'work:toys/kite', files: ['src/kite.ts'] },
      }),
    )
    expect(scoped).not.toContain('Tails are always optional.')
    const denied = await client.callTool({
      name: 'repo_rules',
      arguments: { repo: 'work:other/app' },
    })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('No readable repository work:other/app')
  })

  test('get_rule reads a rule, a learning and a requested rules file', async () => {
    const { store, client } = await setup()
    expect(
      textOf(await client.callTool({ name: 'get_rule', arguments: { id: '[rule:r-fetch]' } })),
    ).toContain('# [rule:r-fetch] Data fetching')
    expect(
      textOf(
        await client.callTool({
          name: 'get_rule',
          arguments: { id: '.cursor/rules/colors.mdc', repo: 'work:toys/kite' },
        }),
      ),
    ).toContain('Colors come from the palette module.')
    await client.callTool({
      name: 'propose_learning',
      arguments: { repo: 'work:toys/kite', text: 'Keep spool sizes in SpoolSize.' },
    })
    const [learning] = await store.learnings.list()
    expect(
      textOf(
        await client.callTool({ name: 'get_rule', arguments: { id: `learn:${learning?.id}` } }),
      ),
    ).toContain('Keep spool sizes in SpoolSize.')
    expect((await client.callTool({ name: 'get_rule', arguments: { id: 'nope' } })).isError).toBe(
      true,
    )
  })

  test('propose_learning stores a pending learning once and merges repeats', async () => {
    const { store, client } = await setup()
    const args = {
      repo: 'work:toys/kite',
      text: 'Put test ids on list rows, not on their wrappers.',
      reason: 'Row selectors broke twice.',
    }
    expect(textOf(await client.callTool({ name: 'propose_learning', arguments: args }))).toMatch(
      /^Proposed \[learn:[\w-]+\] for `work:toys\/kite`\. Agents use it from 2026-11-04/,
    )
    expect(
      textOf(await client.callTool({ name: 'propose_learning', arguments: args })),
    ).toStartWith('Not added: [learn:')
    expect(await store.learnings.list()).toMatchObject([
      {
        status: 'pending',
        origin: 'agent',
        scope: { repos: ['work:toys/kite'] },
        reason: 'Row selectors broke twice.',
      },
    ])
    expect(await store.rules.list()).toHaveLength(1)
    const denied = await client.callTool({
      name: 'propose_learning',
      arguments: { ...args, repo: 'work:sheds/vault' },
    })
    expect(denied.isError).toBe(true)
  })

  test('search_knowledge finds readable rules and active learnings only', async () => {
    const { store, client } = await setup()
    await store.rules.put({
      id: 'r-sheds',
      title: 'Shed widgets',
      body: 'Shed widgets are hidden.',
      scope: { teams: ['sheds'] },
      author: 'sam',
      createdAt: '2026-10-31T08:00:00.000Z',
      updatedAt: '2026-10-31T08:00:00.000Z',
    })
    const found = textOf(
      await client.callTool({
        name: 'search_knowledge',
        arguments: { query: 'widgets', repo: 'work:toys/kite' },
      }),
    )
    expect(found).toContain('[rule:r-fetch] Data fetching')
    expect(found).not.toContain('r-sheds')
  })

  test('test_ids lists the learned convention, overrides and selectors under a path', async () => {
    const { client } = await setup()
    const text = textOf(
      await client.callTool({
        name: 'test_ids',
        arguments: { repo: 'work:toys/kite', path: 'src/shapes' },
      }),
    )
    expect(text).toContain('# Test ids of `work:toys/kite` (catalog of 2026-10-31, abcdef12)')
    expect(text).toContain('- New ids use `data-qa`.')
    expect(text).toContain('starting with the component name in the same style')
    expect(text).toContain('- Files left out: `src/legacy/**` (set by the team).')
    expect(text).toContain(
      '## ShapeList · src/shapes/ShapeList.tsx (1)\n- L2 `<a>` data-qa="shape-list-more"',
    )
    expect(text).not.toContain('WidgetCard')
    expect(
      textOf(await client.callTool({ name: 'test_ids', arguments: { repo: 'work:toys/new' } })),
    ).toBe('No test id catalog for `work:toys/new` yet: the testids analysis has not run there.')
  })

  test('test_ids suggests ids for unsaved content in the learned style', async () => {
    const { client } = await setup()
    const content = `export const ShapeEditor = () => (
  <form>
    <input name="shapeName" />
    <button onClick={saveShape}>Save</button>
    <button data-qa="shape-editor-cancel">Cancel</button>
  </form>
)
`
    const text = textOf(
      await client.callTool({
        name: 'test_ids',
        arguments: { repo: 'work:toys/kite', file: 'src/ShapeEditor.tsx', content },
      }),
    )
    expect(text).toBe(
      [
        'Test ids for `src/ShapeEditor.tsx` use `data-qa`.',
        [
          'Missing:',
          '- L3 `<input>`, input: `data-qa="shape-editor-shape-name-input"`',
          '- L4 `<button>`, button: `data-qa="shape-editor-save-shape-button"`',
        ].join('\n'),
      ].join('\n\n'),
    )
    expect(
      textOf(
        await client.callTool({
          name: 'test_ids',
          arguments: { repo: 'work:toys/kite', file: 'src/legacy/Old.tsx', content },
        }),
      ),
    ).toBe("`src/legacy/Old.tsx` is left out of test ids by the team's settings.")
    for (const half of [{ file: 'src/ShapeEditor.tsx' }, { content }]) {
      const refused = await client.callTool({
        name: 'test_ids',
        arguments: { repo: 'work:toys/kite', ...half },
      })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toBe('Pass both `file` and `content` to get suggested test ids.')
    }
  })

  test('repo_rules adds the asked topics in full after the rules', async () => {
    const { client } = await setup()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'repo_rules',
      'get_rule',
      'test_ids',
      'search_knowledge',
      'propose_learning',
    ])
    const plain = textOf(
      await client.callTool({ name: 'repo_rules', arguments: { repo: 'work:toys/kite' } }),
    )
    expect(plain).not.toContain('# Test ids of')
    expect(plain).not.toContain('# Asset policy of')
    const text = textOf(
      await client.callTool({
        name: 'repo_rules',
        arguments: {
          repo: 'work:toys/kite',
          files: ['src/kite.ts', 'public/kite.png'],
          topics: ['test-ids', 'assets'],
        },
      }),
    )
    expect(text).toStartWith('# Rules for `work:toys/kite`')
    expect(text.indexOf('# Asset policy of `work:toys/kite`')).toBeGreaterThan(
      text.indexOf('Blocks, strongest first:'),
    )
    expect(text).toContain('# Test ids of `work:toys/kite`\n\n- New ids use `data-qa`.')
    expect(text).toContain('## `public/kite.png`\n- `public/kite.png` is a image file.')
    expect(text).not.toContain('## `src/kite.ts`')
    const unknown = await client.callTool({
      name: 'repo_rules',
      arguments: { repo: 'work:toys/kite', topics: ['commits'] },
    })
    expect(unknown.isError).toBe(true)
    const denied = await client.callTool({
      name: 'repo_rules',
      arguments: { repo: 'work:other/app', topics: ['assets'] },
    })
    expect(denied.isError).toBe(true)
  })

  test('repo_rules serves topics of the repository whose rules an agent already has', async () => {
    const { access } = await setup()
    const rules = rulesToolset({
      ...access,
      rules: {
        ...access.rules!,
        resolve: async () => {
          throw new ToolError("This repository's rules are already in your context.")
        },
      },
    })
    const repoRules = rules?.tools.find((tool) => tool.name === 'repo_rules')
    const ctx = { dir: '.', signal: new AbortController().signal }
    const text = await repoRules?.run({ repo: 'work:toys/kite', topics: ['test-ids'] }, ctx)
    expect(text).toStartWith("This repository's rules are already in your context.")
    expect(text).toContain('# Test ids of `work:toys/kite`')
    expect(Promise.resolve(repoRules?.run({ repo: 'work:toys/kite' }, ctx))).rejects.toThrow(
      'already in your context',
    )
  })

  test('without a reader search_knowledge reads a rule, a learning and a rules file by id', async () => {
    const { store, client } = await setup({ reader: false })
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).not.toContain('get_rule')
    expect(client.getInstructions()).not.toContain('get_rule')
    expect(
      textOf(await client.callTool({ name: 'repo_rules', arguments: { repo: 'work:toys/kite' } })),
    ).toContain('Rules to read with search_knowledge (pass `id`) when they fit the work:')
    expect(
      textOf(
        await client.callTool({ name: 'search_knowledge', arguments: { id: '[rule:r-fetch]' } }),
      ),
    ).toContain('# [rule:r-fetch] Data fetching')
    expect(
      textOf(
        await client.callTool({
          name: 'search_knowledge',
          arguments: { id: '.cursor/rules/colors.mdc', repo: 'work:toys/kite' },
        }),
      ),
    ).toContain('Colors come from the palette module.')
    await client.callTool({
      name: 'propose_learning',
      arguments: { repo: 'work:toys/kite', text: 'Keep spool sizes in SpoolSize.' },
    })
    const [learning] = await store.learnings.list()
    expect(
      textOf(
        await client.callTool({
          name: 'search_knowledge',
          arguments: { id: `learn:${learning?.id}` },
        }),
      ),
    ).toContain('Keep spool sizes in SpoolSize.')
    expect(
      textOf(
        await client.callTool({
          name: 'search_knowledge',
          arguments: { query: 'widgets', repo: 'work:toys/kite' },
        }),
      ),
    ).toContain('[rule:r-fetch] Data fetching')
    const empty = await client.callTool({ name: 'search_knowledge', arguments: {} })
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toBe('Pass `query` to search or `id` to read.')
    expect(
      (await client.callTool({ name: 'search_knowledge', arguments: { id: 'nope' } })).isError,
    ).toBe(true)
  })

  test('the assets toolset keeps asset_policy unless told to leave it to repo_rules', async () => {
    const { access } = await setup()
    const assets = access.assets!
    expect(assetsToolset(assets).tools.map((tool) => tool.name)).toEqual([
      'asset_policy',
      'repo_assets',
    ])
    const folded = assetsToolset(assets, { policy: false })
    expect(folded.tools.map((tool) => tool.name)).toEqual(['repo_assets'])
    expect(folded.instructions).not.toContain('asset_policy')
  })

  test('internal agents read other repositories through rules, never their own rules again', async () => {
    const { store, resolve, repoFiles } = await setup()
    await store.rules.put({
      id: 'r-barns',
      title: 'Doors',
      body: 'Barn doors swing outward.',
      scope: { teams: ['barns'] },
      author: 'sam',
      createdAt: '2026-10-31T08:00:00.000Z',
      updatedAt: '2026-10-31T08:00:00.000Z',
    })
    const access = agentRulesAccess({
      store,
      repo: { forge: 'work', path: 'toys/kite', teams: ['toys', 'barns'] },
      targetOf: (value) =>
        value === 'work:sheds/vault'
          ? { forge: 'work', path: 'sheds/vault', teams: ['sheds'] }
          : value === 'work:barns/kite-shop'
            ? { forge: 'work', path: 'barns/kite-shop', teams: ['barns'] }
            : target(value),
      resolve,
      repoFiles,
      testIds: testIdsReader({ store }),
    })
    const unrelated = await access.rules
      ?.resolve('work:sheds/vault', { agent: 'task' })
      .catch((error: unknown) => error)
    expect(unrelated instanceof ToolError && unrelated.message).toContain('share a team')
    expect(
      (await access.rules?.resolve('work:barns/kite-shop', { agent: 'task' }))?.text,
    ).toContain('Barn doors swing outward.')
    const refused = await access.rules
      ?.resolve('work:toys/kite', { agent: 'task' })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ToolError)
    expect(refused instanceof Error && refused.message).toContain('already in your context')
    expect((await access.rules?.resolve('work:toys/boat', { agent: 'task' }))?.text).toContain(
      'Widgets never fetch data themselves.',
    )
    expect(await access.rules?.resolve('work:other/app', { agent: 'task' })).toBeUndefined()
    expect((await access.testIds?.testIds('work:toys/kite'))?.overrides).toEqual({
      exclude: ['src/legacy/**'],
    })
  })
})
