import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import type { QaChange } from './model.ts'
import { type QaSummarySections, staleness, summarizeTask, summaryInputs } from './summary.ts'

const repo = { forge: 'work', path: 'acme/web' }

const change = (id: string, head: string, kind: QaChange['kind'] = 'merge-request'): QaChange => ({
  repo,
  kind,
  id,
  branch: 'main',
  title: `Change ${id}`,
  at: '2026-10-01',
  authors: ['Dev'],
  keys: ['ABC-1'],
  commits: [head],
  head,
})

const sections: QaSummarySections = {
  overview: 'Adds a widget panel.',
  changes: ['A panel shows widgets'],
  verdict: 'must',
  verdictReason: 'Users see a new panel.',
  testCases: [{ title: 'Open the panel', priority: 'high', steps: ['Open it'], expected: 'Shown' }],
  testing: [{ kind: 'e2e', ideas: ['Open and close the panel'] }],
  autotests: [{ level: 'e2e', idea: 'Opens the panel', testIds: ['panel-open', 'made-up'] }],
  risks: ['Shared layout may shift'],
  questions: [],
}

describe('staleness', () => {
  test('reports added, removed and updated changes against the inputs', () => {
    const inputs = summaryInputs([
      change('!1', 'a'),
      change('!2', 'b'),
      change('c1', 'c1', 'commit'),
    ])
    expect(
      staleness(inputs, [change('!2', 'b'), change('c1', 'c1', 'commit'), change('!1', 'a')]),
    ).toBeUndefined()
    expect(
      staleness(inputs, [change('!1', 'a2'), change('c1', 'c1', 'commit'), change('!3', 'd')]),
    ).toEqual({
      added: ['work:acme/web!3'],
      removed: ['work:acme/web!2'],
      updated: ['work:acme/web!1'],
    })
  })
})

describe('summarizeTask', () => {
  test('asks once without repository access and keeps only known test ids', async () => {
    const tasks: AgentTask[] = []
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        tasks.push(task)
        return { text: '', turns: 1, output: sections as Output, model: 'm', costUsd: 0.02 }
      },
    }
    const result = await summarizeTask(agent, {
      key: 'ABC-1',
      title: 'Widget panel',
      changes: [
        {
          change: change('!1', 'a'),
          detail: {
            files: [{ path: 'src/Panel.tsx', status: 'modified', additions: 3, deletions: 1 }],
            testIds: [
              {
                file: 'src/Panel.tsx',
                added: [{ attribute: 'data-testid', value: 'panel-open' }],
                removed: [],
              },
            ],
          },
          excerpt: '--- modified src/Panel.tsx\n+<button data-testid="panel-open">',
        },
      ],
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ capabilities: [], taskKind: 'qa-notes', tier: 'main' })
    expect(tasks[0]?.prompt).toContain('Task ABC-1: Widget panel')
    expect(tasks[0]?.prompt).toContain('added data-testid="panel-open"')
    expect(result.sections.autotests[0]?.testIds).toEqual(['panel-open'])
    expect(result).toMatchObject({ model: 'm', costUsd: 0.02 })
  })

  test('rejects an answer without the structured result', async () => {
    const agent: Agent = { name: 'fake', run: async () => ({ text: 'no', turns: 1 }) }
    expect(summarizeTask(agent, { key: 'ABC-1', title: 'x', changes: [] })).rejects.toThrow(
      'no structured answer',
    )
  })
})
