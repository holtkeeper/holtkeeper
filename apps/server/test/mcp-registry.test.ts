import { describe, expect, test } from 'bun:test'

import type { RepoTarget } from '@holtkeeper/access'
import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import { createGuideResolver, proposeRule, scopesFor } from '@holtkeeper/guide'
import { memoryStore } from '@holtkeeper/store/memory'
import type { TestIdsData } from '@holtkeeper/testids'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'

import { createApiCatalog } from '../src/api-surface/catalog.ts'
import { registryServer } from '../src/api-surface/mcp.ts'
import type { McpCall } from '../src/api-surface/usage.ts'
import { createUsageIndex } from '../src/api-surface/usages.ts'
import { agentRulesAccess, mcpToolsets, taskToolsets } from '../src/tools/registry.ts'
import { type RulesAccess, rulesToolset, testIdsReader } from '../src/tools/rules.ts'

const now = () => new Date('2026-11-01T10:00:00.000Z')
const principal = { id: 'header:sam', name: 'Sam', provider: 'header', grants: [] }

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
    knowledge: {
      store,
      canReadScope: () => true,
      repoOf: () => undefined,
      actor: 'header:sam',
      now,
    },
    canRead: () => true,
    canReadAnalyses: () => true,
    canReadAudits: () => true,
  }

  test('serves catalog and knowledge, and rules only with commit conventions', () => {
    expect(mcpToolsets(base).map((toolset) => toolset.name)).toEqual(['catalog', 'knowledge'])
    const withRules = mcpToolsets({ ...base, commits: { conventions: async () => undefined } })
    expect(withRules.map((toolset) => toolset.name)).toEqual(['catalog', 'knowledge', 'rules'])
    expect(withRules.flatMap((toolset) => toolset.tools.map((tool) => tool.name))).toEqual([
      'list_packages',
      'get_package_api',
      'search_symbols',
      'get_symbol',
      'list_versions',
      'diff_versions',
      'package_usage',
      'find_usages',
      'upgrade_impact',
      'repo_packages',
      'evaluate_dependency',
      'who_uses',
      'search_knowledge',
      'get_knowledge',
      'propose_knowledge',
      'commit_conventions',
      'check_commit_message',
    ])
  })

  test('adds the Guide and test id tools to rules after the existing ones keep their names', () => {
    const rules = mcpToolsets({
      ...base,
      guide: { resolve: async () => undefined },
      proposals: { propose: async () => undefined },
      commits: { conventions: async () => undefined },
      testIds: { testIds: async () => undefined },
    }).find((toolset) => toolset.name === 'rules')
    expect(rules?.tools.map((tool) => [tool.name, tool.readOnly ?? true])).toEqual([
      ['repo_rules', true],
      ['propose_rule_change', false],
      ['commit_conventions', true],
      ['check_commit_message', true],
      ['test_ids', true],
      ['suggest_test_ids', true],
    ])
    expect(rules?.instructions).toStartWith('Call repo_rules before changing code in a repository')
  })

  test('internal tasks mount catalog for reviews, a checkout-free set for chat and nothing for one-shots', () => {
    expect(taskToolsets('review')).toEqual([
      'code',
      'docs',
      'knowledge',
      'libraries',
      'catalog',
      'stack',
      'assets',
    ])
    expect(taskToolsets('guide')).toEqual([])
    expect(taskToolsets('release-notes')).toEqual([])
    expect(taskToolsets('library-digest')).toEqual([])
    expect(taskToolsets('knowledge-bootstrap')).toEqual([])
    expect(taskToolsets('chat')).toEqual([
      'knowledge',
      'libraries',
      'catalog',
      'stack',
      'rules',
      'assets',
      'releases',
      'ops',
    ])
    expect(taskToolsets('chat-summary')).toEqual([])
    expect(taskToolsets('triage')).toEqual(['code', 'docs', 'knowledge', 'libraries'])
    expect(taskToolsets('agent')).not.toContain('catalog')
  })
})

const target = (value: string): RepoTarget | undefined =>
  value.startsWith('work:toys/')
    ? { forge: 'work', path: value.slice('work:'.length), groups: ['toys'] }
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

  async function setup() {
    const store = memoryStore()
    await store.guides.put({
      scope: 'group:toys',
      section: 'general',
      rules: 'Widgets never fetch data themselves.',
      steering: '',
      learnings: [],
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
    const resolve = createGuideResolver({ store })
    const testIds = testIdsReader({ store })
    const access: RulesAccess = {
      guide: {
        resolve: async (value, request) => {
          const repo = target(value)
          return repo ? resolve({ repo, ...request }) : undefined
        },
      },
      proposals: {
        propose: async (value, input) => {
          const repo = target(value)
          return repo
            ? proposeRule(store, {
                repo: value,
                rule: input.rule,
                section: input.section,
                ...(input.targetScope && {
                  targetScope: input.targetScope,
                  scopes: scopesFor(repo),
                }),
                reason: input.reason,
                by: principal.id,
                at: now().toISOString(),
              })
            : undefined
        },
      },
      testIds: {
        testIds: async (value) => {
          const repo = target(value)
          return repo ? testIds(repo) : undefined
        },
      },
    }
    const rules = rulesToolset(access)
    if (!rules) throw new Error('no rules toolset')
    const calls: McpCall[] = []
    return { store, client: await connect(calls, [rules]), calls }
  }

  test('repo_rules returns the resolved Guide of readable repositories only', async () => {
    const { client } = await setup()
    expect(client.getInstructions()).toContain('Call repo_rules before changing code')
    const rules = textOf(
      await client.callTool({ name: 'repo_rules', arguments: { repo: 'work:toys/kite' } }),
    )
    expect(rules).toStartWith('# Rules for `work:toys/kite`')
    expect(rules).toContain('Widgets never fetch data themselves.')
    const denied = await client.callTool({
      name: 'repo_rules',
      arguments: { repo: 'work:other/app', section: 'testids' },
    })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('No readable repository work:other/app')
  })

  test('propose_rule_change stores a learning candidate and never a rule', async () => {
    const { store, client } = await setup()
    const args = {
      repo: 'work:toys/kite',
      section: 'testids',
      rule: 'Put test ids on list rows, not on their wrappers.',
      reason: 'Row selectors broke twice.',
    }
    expect(textOf(await client.callTool({ name: 'propose_rule_change', arguments: args }))).toBe(
      'Proposed "Put test ids on list rows, not on their wrappers." for Test ids of `work:toys/kite`. People review it in Knowledge › Learnings (/knowledge/learnings?space=repo%3Awork%3Atoys%2Fkite) before agents use it.',
    )
    expect(
      textOf(await client.callTool({ name: 'propose_rule_change', arguments: args })),
    ).toStartWith('Not added: `work:toys/kite` already has this rule as a proposed candidate')
    expect(await store.learnings.list()).toMatchObject([
      { status: 'proposed', section: 'testids', proposal: { by: 'header:sam' }, sources: [] },
    ])
    expect(await store.guides.list({ sections: ['testids'] })).toEqual([])
  })

  test('propose_rule_change takes an exact scope of the repository only', async () => {
    const { store, client } = await setup()
    const args = {
      repo: 'work:toys/kite',
      section: 'general',
      rule: 'Keep spool sizes in SpoolSize.',
      reason: 'Every team toy repeats it.',
    }
    const refused = await client.callTool({
      name: 'propose_rule_change',
      arguments: { ...args, scope: 'group:sheds' },
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toBe(
      'Not proposed: group:sheds is not a group, family or repository scope of work:toys/kite.',
    )
    expect(
      textOf(
        await client.callTool({
          name: 'propose_rule_change',
          arguments: { ...args, scope: 'group:toys' },
        }),
      ),
    ).toContain('of `work:toys/kite` into group:toys.')
    expect(await store.learnings.list()).toMatchObject([
      { suggestedScope: 'group', targetScope: 'group:toys' },
    ])
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

  test('suggest_test_ids suggests ids for unsaved content in the learned style', async () => {
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
        name: 'suggest_test_ids',
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
          name: 'suggest_test_ids',
          arguments: { repo: 'work:toys/kite', file: 'src/legacy/Old.tsx', content },
        }),
      ),
    ).toBe("`src/legacy/Old.tsx` is left out of test ids by the team's settings.")
  })

  test('internal agents read other repositories through rules, never their own Guide again', async () => {
    const { store } = await setup()
    await store.guides.put({
      scope: 'group:barns',
      section: 'general',
      rules: 'Barn doors swing outward.',
      steering: '',
      learnings: [],
    })
    await store.families.put({
      id: 'f1',
      name: 'kites',
      members: ['work:barns/kite-shop', 'work:toys/kite'],
      createdBy: 'sam',
      createdAt: '2026-10-31T08:00:00.000Z',
      updatedAt: '2026-10-31T08:00:00.000Z',
    })
    const access = agentRulesAccess({
      repo: { forge: 'work', path: 'toys/kite', groups: ['toys'] },
      targetOf: (value) =>
        value === 'work:sheds/vault'
          ? { forge: 'work', path: 'sheds/vault', groups: ['sheds'] }
          : value === 'work:barns/kite-shop'
            ? { forge: 'work', path: 'barns/kite-shop', groups: ['barns'] }
            : target(value),
      resolve: createGuideResolver({ store }),
      testIds: testIdsReader({ store }),
      families: () => store.families.list(),
    })
    const unrelated = await access.guide
      ?.resolve('work:sheds/vault', { task: 'agent' })
      .catch((error: unknown) => error)
    expect(unrelated instanceof ToolError && unrelated.message).toContain(
      'share a team or a family',
    )
    expect(
      (await access.guide?.resolve('work:barns/kite-shop', { task: 'agent' }))?.text,
    ).toContain('Barn doors swing outward.')
    const refused = await access.guide
      ?.resolve('work:toys/kite', { task: 'agent' })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ToolError)
    expect(refused instanceof Error && refused.message).toContain('already in your context')
    expect((await access.guide?.resolve('work:toys/boat', { task: 'agent' }))?.text).toContain(
      'Widgets never fetch data themselves.',
    )
    expect(await access.guide?.resolve('work:other/app', { task: 'agent' })).toBeUndefined()
    expect((await access.testIds?.testIds('work:toys/kite'))?.overrides).toEqual({
      exclude: ['src/legacy/**'],
    })
  })
})
