import { describe, expect, test } from 'bun:test'

import type { Agent } from '@holtkeeper/agent'

import { sourceComment } from './comment.ts'
import { portAnalysis, portTotals } from './report.ts'
import { agentTriage, type Triage } from './triage.ts'
import type { PortData, TargetOutcome } from './types.ts'

const target = (
  repo: string,
  outcome: TargetOutcome['outcome'],
  extra: Partial<TargetOutcome> = {},
): TargetOutcome => ({
  repo,
  webUrl: `https://git.test/${repo}`,
  outcome,
  remapped: [],
  checks: [],
  changedFiles: [],
  diffStat: { files: 0, additions: 0, deletions: 0 },
  notes: [],
  ...extra,
})

const run = (targets: TargetOutcome[], mergeRequest = 7): PortData => ({
  group: 'games',
  source: {
    repo: 'work:libs/core',
    kind: 'merge-request',
    mergeRequest,
    title: 'Require a password',
    description: '',
    webUrl: 'https://git.test/libs/core/-/merge_requests/7',
    issues: ['#12'],
    intent: 'Title: Require a password',
    files: [
      {
        oldPath: 'src/login.ts',
        newPath: 'src/login.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        diff: '@@ -1,2 +1,3 @@\n a\n+b\n c\n',
      },
    ],
  },
  branch: 'holtkeeper/port/core-mr-7',
  dryRun: false,
  targets,
})

const record = (data: PortData, createdAt: string) => ({
  id: createdAt,
  repo: { forge: 'work', path: 'games' },
  kind: 'port',
  createdAt,
  data,
})

const failing = {
  name: 'test',
  command: 'bun test',
  exitCode: 1,
  ok: false,
  output: 'expected 2',
  durationMs: 5,
  attempt: 1,
}

describe('port report', () => {
  const previous = run([
    target('games/a', 'failed', { method: 'clean', checks: [failing] }),
    target('games/b', 'not-applicable'),
  ])
  const current = run([
    target('games/a', 'ported-adapted', {
      method: 'adapted',
      adapt: {
        status: 'ported',
        summary: 'Ported by hand.',
        changes: ['src/a.ts'],
        deviations: ['kept LoginError'],
      },
      diffStat: { files: 1, additions: 2, deletions: 1 },
      changedFiles: ['src/a.ts'],
      mergeRequest: { id: 4, url: 'https://git.test/games/a/-/merge_requests/4', draft: false },
    }),
    target('games/b', 'not-applicable', {
      reason: 'no login code',
      triage: { verdict: 'not-applicable', reason: 'no login code', by: 'rules' },
    }),
    target('games/c', 'failed', {
      method: 'clean',
      checks: [failing],
      reason: 'checks fail: test',
    }),
    target('games/d', 'error', { error: 'clone failed' }),
  ])

  test('counts targets and compares with a previous port of the same source', () => {
    expect(portTotals(current)).toMatchObject({
      targets: 4,
      ported: 1,
      adapted: 1,
      skipped: 1,
      failed: 2,
      mergeRequests: 1,
    })
    const report = portAnalysis.toReport(record(current, '2'), record(previous, '1'))
    const metrics = Object.fromEntries(report.metrics.map((metric) => [metric.id, metric]))
    expect(metrics['ported']).toMatchObject({ value: 1, delta: 1 })
    expect(metrics['failed']).toMatchObject({ value: 2, delta: 1, tone: 'bad' })
    expect(metrics['targets']).toMatchObject({ value: 4, delta: 2 })
    const other = portAnalysis.toReport(record(current, '2'), record(run(previous.targets, 8), '1'))
    expect(other.metrics.find((metric) => metric.id === 'ported')?.delta).toBeUndefined()
  })

  test('has overview, adaptations, skipped, failures and source sections', () => {
    const report = portAnalysis.toReport(record(current, '2'), record(previous, '1'))
    expect(report.sections.map((section) => section.id)).toEqual([
      'overview',
      'adaptations',
      'skipped',
      'failures',
      'source',
    ])
    const table = report.sections[0]!.blocks[1]
    expect(table?.type === 'table' && table.columns.map((column) => column.key)).toContain(
      'previous',
    )
    const adaptations = report.sections[1]!.blocks[0]
    expect(adaptations?.type === 'markdown' && adaptations.text).toContain('kept LoginError')
    const failures = report.sections[3]!.blocks[0]
    expect(failures?.type === 'issues' && failures.items.map((item) => item.id)).toEqual([
      'games/c:test',
      'games/d:error',
    ])
    const changes = report.sections[4]!.blocks[1]
    expect(changes).toMatchObject({ type: 'changes', applicable: false })
    expect(changes?.type === 'changes' && changes.items[0]?.diff[0]?.hunks[0]?.lines).toHaveLength(
      3,
    )
    expect(portAnalysis.schema.parse(current)).toEqual(current)
  })

  test('the source comment lists every target', () => {
    const body = sourceComment(current)
    expect(body).toContain('1 of 4 repositories ported')
    expect(body).toContain(
      '| `games/a` | Ported (adapted by agent) | [!4](https://git.test/games/a/-/merge_requests/4) |',
    )
    expect(body).toContain('| `games/b` | Not applicable — no login code | — |')
  })
})

describe('agentTriage', () => {
  const unclear: Triage = {
    triage: async () => ({ verdict: 'unclear', reason: 'mixed', by: 'rules', symbols: ['login'] }),
  }
  const input = {
    dir: '/tmp',
    runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    files: [],
    intent: 'x',
  }

  test('asks the agent only when the rules are unsure', async () => {
    const kinds: (string | undefined)[] = []
    const agent: Agent = {
      name: 'fake',
      run: async (task) => {
        kinds.push(task.taskKind)
        return {
          text: '',
          turns: 1,
          output: { verdict: 'not-applicable', reason: 'different auth' } as never,
        }
      },
    }
    expect(await agentTriage(agent, unclear).triage(input)).toEqual({
      verdict: 'not-applicable',
      reason: 'different auth',
      by: 'agent',
      symbols: ['login'],
    })
    expect(kinds).toEqual(['triage'])
    const sure: Triage = { triage: async () => ({ verdict: 'apply', reason: 'ok', by: 'rules' }) }
    expect((await agentTriage(agent, sure).triage(input)).by).toBe('rules')
    expect(kinds).toHaveLength(1)
  })

  test('keeps the rules verdict when the agent fails', async () => {
    const agent: Agent = { name: 'broken', run: () => Promise.reject(new Error('down')) }
    expect((await agentTriage(agent, unclear).triage(input)).verdict).toBe('unclear')
  })
})
