import { describe, expect, test } from 'bun:test'

import type { Principal, RepoTarget } from '@holtkeeper/access'
import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import { ToolError } from '@holtkeeper/agent-tools'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { SettingEntry } from '@holtkeeper/store'

import type { AgentEvidence, AgentJob } from './agent.ts'
import { type AskDeps, askService, buildAskPrompt, mcpAskOf, renderAnswer } from './ask.ts'

const principal: Principal = { id: 'u1', name: 'Uma', provider: 'test', grants: [] }

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only what resolving a repository target reads
const config = { forges: { gitlab: {} }, teams: {}, repos: {} } as unknown as HoltkeeperConfig

const entry = (value: unknown): SettingEntry =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields `mcpAskOf` reads
  ({
    id: 's1',
    key: 'mcp.ask',
    scope: { all: true },
    value,
    updatedAt: '2026-01-05',
  }) as SettingEntry

const ctx = () => ({ signal: new AbortController().signal })

interface Script {
  evidence?: AgentEvidence[]
  text?: string
  error?: unknown
}

function setup(
  script: Script,
  options: {
    setting?: unknown
    spentUsd?: number
    provider?: boolean
    rules?: boolean
    teams?: string[]
  } = {},
) {
  const kv = new Map<string, unknown>()
  const tasks: AgentTask[] = []
  const jobs: AgentJob[] = []
  const targets: RepoTarget[] = []
  const deps: AskDeps = {
    config,
    settings: {
      list: async (key?: string) =>
        key === 'llm.provider'
          ? options.provider === false
            ? []
            : [{ ...entry('main'), key: 'llm.provider' }]
          : [entry(options.setting ?? { enabled: true })],
    },
    aiUsage: {
      aggregate: async () =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only `costUsd` is read
        [{ key: {}, costUsd: options.spentUsd ?? 0 }] as never,
    },
    kv: {
      get: async (key) => kv.get(key),
      set: async (key, value) => void kv.set(key, value),
      compareAndSet: async (key, expected, value) => {
        if (kv.get(key) !== expected) return false
        kv.set(key, value)
        return true
      },
    },
    agentFor: async (target, job) => {
      targets.push(target)
      jobs.push(job)
      const agent: Agent = {
        name: 'fake',
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a text-only result
        run: (async (task: AgentTask) => {
          tasks.push(task)
          for (const item of script.evidence ?? []) job.onEvidence?.(item)
          if (script.error) throw script.error
          return { text: script.text ?? '' }
        }) as Agent['run'],
      }
      return agent
    },
    homeTeams: async () => ['shop', 'other'],
    canReadRepo: (_principal, repo) => repo === 'gitlab:acme/shop',
    canReadTeam: (_principal, team) => (options.teams ?? ['shop']).includes(team),
    canReadRules: () => options.rules ?? true,
    now: () => new Date('2026-01-07T10:00:00Z'),
  }
  return { service: askService(deps), kv, tasks, jobs, targets }
}

const rule: AgentEvidence = {
  source: 'search_knowledge',
  text: '### [rule:r1] Widget sizes\nKeep widget sizes in WidgetSize.',
}

describe('mcpAskOf', () => {
  test('is off with defaults until someone turns it on', () => {
    expect(mcpAskOf([])).toEqual({
      enabled: false,
      perAnswerUsd: 0.3,
      perPersonPerDay: 30,
      weeklyUsd: 15,
    })
    expect(mcpAskOf([entry({ enabled: true, weeklyUsd: 5 })])).toMatchObject({
      enabled: true,
      weeklyUsd: 5,
    })
  })
})

describe('buildAskPrompt', () => {
  test('names the repository and files before the question', () => {
    expect(
      buildAskPrompt({
        question: ' Where do sizes live? ',
        repo: 'gitlab:acme/shop',
        files: ['a.ts'],
      }),
    ).toBe('Repository: gitlab:acme/shop\nFiles: a.ts\nQuestion: Where do sizes live?')
  })
})

describe('renderAnswer', () => {
  test('lists backed sources and counts the dropped ones', () => {
    const rendered = renderAnswer(
      'Sizes live in WidgetSize [rule:r1]. Since 3.0 [pkg:some-lib@3.0.0].',
      [rule],
    )
    expect(rendered.grounded).toBe(true)
    expect(rendered.text).toContain('Sizes live in WidgetSize [rule:r1]. Since 3.0 [unverified].')
    expect(rendered.text).toContain('Sources:\n- [rule:r1]')
    expect(rendered.text).toContain('1 source named in the answer was not in anything it read')
  })

  test('refuses an answer no source backs and says what was read', () => {
    const rendered = renderAnswer('It is fine [rule:zz].', [rule, rule])
    expect(rendered.grounded).toBe(false)
    expect(rendered.text).toContain('No grounded answer')
    expect(rendered.text).toContain('search_knowledge ×2')
    expect(rendered.text).not.toContain('It is fine')
  })
})

describe('askService', () => {
  test('offers nothing while the setting is off', async () => {
    const { service } = setup({}, { setting: { enabled: false } })
    expect(await service.accessFor(principal)).toBeUndefined()
  })

  test('answers as an interactive read-only run of the asker and reuses the answer', async () => {
    const { service, tasks, jobs, kv } = setup({
      evidence: [rule],
      text: 'Keep sizes in WidgetSize [rule:r1].',
    })
    const access = await service.accessFor(principal)
    const progress: string[] = []
    const input = { question: 'Where do widget sizes live?', repo: 'gitlab:acme/shop' }
    const text = await access?.ask(input, { ...ctx(), progress: (line) => progress.push(line) })
    expect(text).toContain('Keep sizes in WidgetSize [rule:r1].')
    expect(text).toContain('Sources:\n- [rule:r1]')
    expect(progress).toEqual(['read search_knowledge'])
    expect(jobs[0]).toMatchObject({ actor: 'u1', interactive: true, requester: principal })
    expect(tasks[0]).toMatchObject({
      taskKind: 'ask',
      capabilities: [],
      maxCostUsd: 0.3,
      prompt: 'Repository: gitlab:acme/shop\nQuestion: Where do widget sizes live?',
    })
    expect(await access?.ask({ ...input, question: ' where do widget sizes LIVE? ' }, ctx())).toBe(
      text ?? '',
    )
    expect(tasks).toHaveLength(1)
    expect(kv.get('mcp-ask:u1:2026-01-07')).toBe(1)
  })

  test('does not keep an answer without sources', async () => {
    const { service, tasks } = setup({ text: 'Probably fine.' })
    const access = await service.accessFor(principal)
    const input = { question: 'Is some-lib safe to upgrade?' }
    expect(await access?.ask(input, ctx())).toContain('No grounded answer')
    await access?.ask(input, ctx())
    expect(tasks).toHaveLength(2)
  })

  test('refuses repositories the asker may not read', async () => {
    const { service, tasks } = setup({})
    const access = await service.accessFor(principal)
    expect(
      access?.ask({ question: 'What is in there?', repo: 'gitlab:acme/other' }, ctx()),
    ).rejects.toThrow(ToolError)
    expect(tasks).toHaveLength(0)
  })

  test('stops at the daily count and the weekly spend', async () => {
    const daily = setup(
      { evidence: [rule], text: 'Yes [rule:r1].' },
      { setting: { enabled: true, perPersonPerDay: 1 } },
    )
    const first = await daily.service.accessFor(principal)
    await first?.ask({ question: 'First question here?' }, ctx())
    expect(first?.ask({ question: 'Second question here?' }, ctx())).rejects.toThrow('daily limit')

    const weekly = setup({}, { spentUsd: 15 })
    const access = await weekly.service.accessFor(principal)
    expect(access?.ask({ question: 'Anything at all?' }, ctx())).rejects.toThrow('weekly budget')
    expect(weekly.tasks).toHaveLength(0)
  })

  test('turns a run stopped at its cap into a message for the caller', async () => {
    const { service } = setup({
      error: new BudgetExceededError('cap reached', { costUsd: 0.3 }),
    })
    const access = await service.accessFor(principal)
    expect(access?.ask({ question: 'Something very broad?' }, ctx())).rejects.toThrow('$0.30 cap')
  })

  test('offers nothing without an AI provider', async () => {
    const { service } = setup({}, { provider: false })
    expect(await service.accessFor(principal)).toBeUndefined()
  })

  test('a question without a repository runs for the home teams the asker may read', async () => {
    const { service, targets } = setup({ evidence: [rule], text: 'Yes [rule:r1].' })
    const access = await service.accessFor(principal)
    await access?.ask({ question: 'Where do widget sizes live?' }, ctx())
    expect(targets[0]).toEqual({ forge: 'mcp', path: 'ask', teams: ['shop'] })
  })

  test('an asker who may not read the rules of the repository gets a run without them', async () => {
    const { service, tasks } = setup({ evidence: [rule], text: 'Yes [rule:r1].' }, { rules: false })
    const access = await service.accessFor(principal)
    await access?.ask({ question: 'Where do widget sizes live?', repo: 'gitlab:acme/shop' }, ctx())
    expect(tasks[0]?.context).toContain('may not read the rules')
  })

  test('parallel questions cannot pass the daily count together', async () => {
    const { service, tasks } = setup(
      { evidence: [rule], text: 'Yes [rule:r1].' },
      { setting: { enabled: true, perPersonPerDay: 2 } },
    )
    const access = await service.accessFor(principal)
    const results = await Promise.allSettled(
      ['One question here?', 'Two questions here?', 'Three questions here?'].map(async (question) =>
        access?.ask({ question }, ctx()),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(tasks).toHaveLength(2)
  })
})
