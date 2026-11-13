import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import type { BootstrapEvidence } from './evidence-code.ts'
import {
  CALL_CAPS,
  type EvidenceLinks,
  acceptLessons,
  estimateBootstrapCost,
  evidenceLink,
  generateLessons,
} from './generate.ts'
import { BOOTSTRAP_CONTEXT, type BootstrapOutput } from './prompt.ts'

const evidence: BootstrapEvidence[] = [
  { id: 'manifests', label: 'Manifests', text: 'go.mod: example.com/widgets' },
  {
    id: 'file:docs/adr/0001-kit.md',
    label: 'ADR: Use kit',
    text: 'Retries go through kit.',
    path: 'docs/adr/0001-kit.md',
  },
  { id: 'mr:12', label: '!12 Retry with kit', text: 'reviewer 1: use kit.Retry' },
  { id: 'mr-titles', label: 'Merged merge requests', text: '!12 Retry with kit' },
]

const links: EvidenceLinks = {
  forgeKind: 'gitlab',
  webUrl: 'https://forge.test/acme/widget-api',
  sha: 'abc123',
  mergeRequests: [
    {
      id: 12,
      title: 'Retry with kit',
      webUrl: 'https://forge.test/acme/widget-api/-/merge_requests/12',
    },
  ],
}

const lesson = (overrides: Partial<BootstrapOutput['lessons'][number]> = {}) => ({
  title: 'Retry outbound calls with kit.Retry',
  body: 'Reviewers ask for `kit.Retry` instead of hand-written loops.',
  kind: 'convention' as const,
  evidence: ['mr:12'],
  level: 'repo' as const,
  repoSpecific: false,
  ...overrides,
})

const context = {
  evidence,
  existingIds: new Set(['e-1']),
  dependencies: new Set(['Go:example.com/kit', 'npm:some-lib']),
  maxEntries: 3,
  links,
}

describe('acceptLessons', () => {
  test('drops unknown evidence, validates library and related, and caps the list', () => {
    const { lessons, dropped } = acceptLessons(
      {
        lessons: [
          lesson({
            evidence: ['mr:12', 'mr:99', 'file:docs/adr/0001-kit.md'],
            related: ['kb:e-1', 'e-2'],
          }),
          lesson({ title: 'Invented', evidence: ['mr:404'] }),
          lesson({ title: 'Kit retries', level: 'library', library: 'example.com/kit' }),
          lesson({ title: 'Unknown lib', level: 'library', library: 'Go:example.com/elsewhere' }),
          lesson({ title: 'Migration without library', kind: 'migration' }),
        ],
      },
      context,
    )
    expect(dropped).toEqual([
      { title: 'Invented', reason: 'no known evidence' },
      { title: 'Migration without library', reason: 'over the limit of 3' },
    ])
    expect(lessons.map((item) => [item.title, item.level, item.library, item.related])).toEqual([
      ['Retry outbound calls with kit.Retry', 'repo', undefined, ['e-1']],
      ['Kit retries', 'library', 'Go:example.com/kit', undefined],
      ['Unknown lib', 'repo', undefined, undefined],
    ])
    expect(lessons[0]?.evidence).toEqual([
      {
        label: '!12 Retry with kit',
        url: 'https://forge.test/acme/widget-api/-/merge_requests/12',
      },
      {
        label: 'ADR: Use kit',
        url: 'https://forge.test/acme/widget-api/-/blob/abc123/docs/adr/0001-kit.md',
      },
    ])
  })

  test('a migration without a known library becomes a how-to', () => {
    const { lessons } = acceptLessons({ lessons: [lesson({ kind: 'migration' })] }, context)
    expect(lessons[0]?.kind).toBe('howto')
  })
})

describe('evidenceLink', () => {
  test('links merge requests, files, the tree and the merged list per forge', () => {
    expect(evidenceLink(evidence[0]!, links)).toEqual({
      label: 'Manifests',
      url: 'https://forge.test/acme/widget-api/-/tree/abc123',
    })
    expect(evidenceLink(evidence[3]!, links)?.url).toBe(
      'https://forge.test/acme/widget-api/-/merge_requests?state=merged',
    )
    expect(evidenceLink(evidence[1]!, { ...links, forgeKind: 'github' })?.url).toBe(
      'https://forge.test/acme/widget-api/blob/abc123/docs/adr/0001-kit.md',
    )
    expect(evidenceLink(evidence[1]!, { ...links, forgeKind: 'other' })).toBeUndefined()
    expect(evidenceLink(evidence[2]!, { mergeRequests: [] })).toBeUndefined()
  })
})

describe('estimateBootstrapCost', () => {
  test('about twelve cents for a full prompt on main, more on deep, under the caps', () => {
    const main = estimateBootstrapCost(60_000, 'main')
    expect(main.usd).toBeGreaterThan(0.1)
    expect(main.usd).toBeLessThan(0.14)
    const deep = estimateBootstrapCost(60_000, 'deep')
    expect(deep.usd).toBeGreaterThan(main.usd)
    expect(deep.usd).toBeLessThan(CALL_CAPS.deep)
    expect(estimateBootstrapCost(60_000, 'main', 3).usd).toBeLessThan(main.usd)
  })
})

describe('generateLessons', () => {
  test('one tool-less capped call with the estimate, the task kind and its own context', async () => {
    const tasks: AgentTask[] = []
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        tasks.push(task)
        const output = { lessons: [lesson(), lesson({ title: 'x', evidence: ['nope'] })] }
        return {
          text: '',
          output: task.output?.parse(output),
          turns: 1,
          costUsd: 0.09,
          model: 'model-main',
        }
      },
    }
    const lines: string[] = []
    const result = await generateLessons({
      agent,
      dir: '/checkout',
      tier: 'main',
      links,
      prompt: {
        repo: 'work:acme/widget-api',
        groups: ['shapes.round', 'shapes'],
        since: '2026-05-13',
        maxEntries: 10,
        evidence,
        existing: [
          {
            id: 'e-1',
            scope: 'repo work:acme/widget-web',
            title: 'Retry with kit',
            body: 'Use kit.Retry.',
          },
        ],
        libraries: [{ subject: 'Go:example.com/kit', home: 'work:acme/kit' }],
        dependencies: ['Go:example.com/kit'],
        extra: 'Focus on retries.',
      },
      log: (line) => lines.push(line),
    })
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(task).toMatchObject({
      capabilities: [],
      maxTurns: 2,
      tier: 'main',
      maxCostUsd: CALL_CAPS.main,
      taskKind: 'knowledge-bootstrap',
      context: BOOTSTRAP_CONTEXT,
    })
    expect(task.estimateUsd).toBe(result.call.estimateUsd)
    expect(task.estimateUsd).toBeGreaterThan(0)
    expect(task.prompt).toContain('## [mr:12] !12 Retry with kit')
    expect(task.prompt).toContain('- kb:e-1 [repo work:acme/widget-web] Retry with kit')
    expect(task.prompt).toContain('- Go:example.com/kit → work:acme/kit')
    expect(task.prompt).toContain('Focus on retries.')
    expect(result.lessons.map((item) => item.title)).toEqual([
      'Retry outbound calls with kit.Retry',
    ])
    expect(result.dropped).toEqual([{ title: 'x', reason: 'no known evidence' }])
    expect(result.call).toMatchObject({ tier: 'main', model: 'model-main', costUsd: 0.09 })
    expect(lines[0]).toMatch(
      /^budget: estimate \$0\.\d\d, cap \$0\.40 \(tier main, ~\d+k input tokens\)$/,
    )
  })
})
