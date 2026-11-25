import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type { DiffFile } from '@holtkeeper/forge'

import {
  AREA_CONCURRENCY,
  AREA_MAX_TURNS,
  AREA_MIN_TURNS,
  areaTurns,
  capFindings,
  dropDuplicateFindings,
  finalizeFindings,
  runUpgradeCheck,
  sameFinding,
  settleVerdict,
  verdictFloor,
} from './agent.ts'
import type { ChangedFile } from './files.ts'
import { diffFilesSource } from './git.ts'
import { UPGRADE_CHECK_TASK_KIND, UPGRADE_PLAN_TASK_KIND, type UpgradeFinding } from './schema.ts'

type Draft = Omit<UpgradeFinding, 'id'>

const draft = (title: string, extra: Partial<Draft> = {}): Draft => ({
  severity: 'risky',
  category: 'config',
  title,
  detail: 'Detail.',
  files: [{ path: 'src/config.ts' }],
  check: 'Check it.',
  ...extra,
})

const diffFile = (path: string, lines = 5): DiffFile => ({
  oldPath: path,
  newPath: path,
  status: 'modified',
  diff: `@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')}\n`,
})

const point = (ref: string, sha: string) => ({ ref, sha })

const changedFile = (lines: number): ChangedFile => ({
  path: 'src/a.ts',
  oldPath: 'src/a.ts',
  status: 'modified',
  added: lines,
  deleted: 0,
  binary: false,
})

interface Answers {
  plan?: (task: AgentTask) => unknown
  area?: (task: AgentTask) => unknown
  verdict?: (task: AgentTask) => unknown
}

function fakeAgent(answers: Answers) {
  const tasks: AgentTask[] = []
  let running = 0
  let peak = 0
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      running++
      peak = Math.max(peak, running)
      await Bun.sleep(1)
      running--
      const answer =
        task.taskKind === UPGRADE_CHECK_TASK_KIND
          ? answers.area?.(task)
          : task.phase === 'plan'
            ? answers.plan?.(task)
            : answers.verdict?.(task)
      if (answer instanceof Error) throw answer
      return { text: '', output: answer as Output, turns: 2, costUsd: 0.5 }
    },
  }
  return { agent, tasks, peak: () => peak }
}

describe('finding helpers', () => {
  test('sameFinding matches equal titles, same lines or similar titles on a shared file', () => {
    expect(sameFinding(draft('Env var renamed'), draft('env var renamed'))).toBe(true)
    expect(
      sameFinding(
        draft('A', { files: [{ path: 'x.ts', line: 3 }] }),
        draft('B', { files: [{ path: 'x.ts', line: 3 }] }),
      ),
    ).toBe(true)
    expect(
      sameFinding(draft('WIDGET_URL variable removed'), draft('Removed WIDGET_URL variable')),
    ).toBe(true)
    expect(sameFinding(draft('Same', { category: 'api' }), draft('Same'))).toBe(false)
  })

  test('dropDuplicateFindings keeps the higher severity and merges files', () => {
    const merged = dropDuplicateFindings([
      draft('Port changed', { severity: 'risky', category: 'infra' }),
      draft('Port changed', {
        severity: 'breaking',
        category: 'infra',
        files: [{ path: 'deploy/chart.yaml' }],
      }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.severity).toBe('breaking')
    expect(merged[0]?.files.map((file) => file.path)).toEqual([
      'src/config.ts',
      'deploy/chart.yaml',
    ])
  })

  test('finalizeFindings sorts by severity with stable unique ids', () => {
    const first = finalizeFindings([
      draft('B', { severity: 'info' }),
      draft('A', { severity: 'breaking' }),
    ])
    expect(first.map((finding) => finding.title)).toEqual(['A', 'B'])
    const again = finalizeFindings([draft('A', { severity: 'breaking' })])
    expect(again[0]?.id).toBe(first[0]?.id as string)
    const twins = finalizeFindings([draft('C'), draft('C')])
    expect(new Set(twins.map((finding) => finding.id)).size).toBe(2)
  })

  test('verdictFloor follows the worst severity', () => {
    expect(verdictFloor([])).toBe('safe')
    expect(verdictFloor([{ severity: 'info' }, { severity: 'risky' }])).toBe('review')
    expect(verdictFloor([{ severity: 'breaking' }])).toBe('breaking')
  })

  test('settleVerdict keeps the model within what the findings support', () => {
    expect(settleVerdict('breaking', [{ severity: 'risky' }], false)).toBe('review')
    expect(settleVerdict('breaking', [], false)).toBe('review')
    expect(settleVerdict('safe', [{ severity: 'breaking' }], false)).toBe('breaking')
    expect(settleVerdict('review', [], false)).toBe('review')
    expect(settleVerdict(undefined, [], true)).toBe('review')
    expect(settleVerdict(undefined, [], false)).toBe('safe')
  })

  test('capFindings keeps the most severe findings in their order', () => {
    const kept = capFindings(
      [
        draft('info 1', { severity: 'info' }),
        draft('risky 1'),
        draft('breaking 1', { severity: 'breaking' }),
        draft('risky 2'),
      ],
      3,
    )
    expect(kept.map((finding) => finding.title)).toEqual(['breaking 1', 'risky 1', 'risky 2'])
  })

  test('areaTurns grows with the area and stays within its bounds', () => {
    expect(areaTurns({ files: [changedFile(20)] })).toBe(AREA_MIN_TURNS + 2)
    expect(areaTurns({ files: [changedFile(100_000)] })).toBe(AREA_MAX_TURNS)
  })
})

describe('runUpgradeCheck', () => {
  const run = {
    dir: '/checkout',
    from: point('v1.0.0', 'a'.repeat(40)),
    to: point('v2.0.0', 'b'.repeat(40)),
  }

  test('is safe without agent calls when only lockfiles changed', async () => {
    const { agent, tasks } = fakeAgent({})
    const data = await runUpgradeCheck({
      ...run,
      agent,
      source: diffFilesSource([diffFile('bun.lock')]),
    })
    expect(tasks).toHaveLength(0)
    expect(data.verdict).toBe('safe')
    expect(data.skipped).toEqual([{ files: 1, reason: 'lockfiles, generated or vendored files' }])
  })

  test('plans, checks every area in parallel, merges findings and gives a verdict', async () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: 3 }, (_unused, j) => diffFile(`services/svc${i}/file${j}.go`, 30)),
    ).flat()
    const { agent, tasks, peak } = fakeAgent({
      plan: () => ({ areas: [{ number: 1, name: 'Billing', focus: 'Look at migrations.' }] }),
      area: (task) =>
        task.prompt.includes('area 1 of')
          ? {
              summary: 'Adds a migration.',
              findings: [
                {
                  severity: 'breaking',
                  category: 'data',
                  title: 'Drops the legacy column',
                  detail: 'Old rows lose data.',
                  files: [{ path: './services/svc0/file0.go', line: 0 }],
                  check: 'Back up the table.',
                },
              ],
            }
          : {
              summary: 'Nothing that breaks.',
              findings: [
                {
                  severity: 'info',
                  category: 'other',
                  title: 'Renames a helper',
                  detail: 'Internal.',
                  files: [],
                  check: 'Nothing to do.',
                },
              ],
            },
      verdict: () => ({ verdict: 'review', summary: 'Mostly safe.', duplicates: [] }),
    })
    const data = await runUpgradeCheck({
      ...run,
      agent,
      source: diffFilesSource(files),
      commits: ['feat: add billing tables'],
      apiChanges: '- `@acme/widgets`: removed `makeWidget`',
      dependencyChanges: '- some-lib 1.0.0 → 2.0.0',
    })
    const areaTasks = tasks.filter((task) => task.taskKind === UPGRADE_CHECK_TASK_KIND)
    expect(areaTasks).toHaveLength(8)
    expect(peak()).toBeLessThanOrEqual(AREA_CONCURRENCY + 1)
    expect(areaTasks.every((task) => task.tier === 'main')).toBe(true)
    expect(areaTasks[0]?.prompt).toContain('Billing')
    expect(areaTasks[0]?.prompt).toContain('suggests looking at: Look at migrations.')
    expect(areaTasks[0]?.prompt).toContain('removed `makeWidget`')
    expect(areaTasks[0]?.prompt).toContain('some-lib 1.0.0 → 2.0.0')
    expect(areaTasks[0]?.prompt).toContain('feat: add billing tables')
    const planTasks = tasks.filter((task) => task.taskKind === UPGRADE_PLAN_TASK_KIND)
    expect(planTasks.map((task) => [task.phase, task.tier, task.capabilities])).toEqual([
      ['plan', 'fast', []],
      ['verdict', 'fast', []],
    ])
    expect(data.verdict).toBe('breaking')
    expect(data.summary).toBe('Mostly safe.')
    expect(data.areas).toHaveLength(8)
    expect(data.areas[0]?.name).toBe('Billing')
    expect(data.areas.reduce((sum, area) => sum + area.files, 0)).toBe(30)
    expect(data.findings.map((finding) => finding.title)).toEqual([
      'Drops the legacy column',
      'Renames a helper',
    ])
    expect(data.findings[0]?.files).toEqual([{ path: 'services/svc0/file0.go' }])
    expect(data.usage).toEqual({ turns: 20, costUsd: 5 })
    expect(data.capped).toBe(false)
  })

  test('asks every call for summaries and findings in the configured language', async () => {
    const files = [diffFile('src/a.ts', 30), diffFile('lib/b.ts', 30)]
    const answers = {
      plan: () => ({ areas: [] }),
      area: () => ({ summary: 'S', findings: [] }),
      verdict: () => ({ verdict: 'safe', summary: 'Fine.', duplicates: [] }),
    }
    const english = fakeAgent(answers)
    await runUpgradeCheck({ ...run, agent: english.agent, source: diffFilesSource(files) })
    expect(english.tasks.length).toBeGreaterThan(1)
    expect(
      english.tasks.every((task) =>
        task.system?.includes('findings (title, detail, check, affects) in English.'),
      ),
    ).toBe(true)

    const other = fakeAgent(answers)
    await runUpgradeCheck({
      ...run,
      agent: other.agent,
      source: diffFilesSource(files),
      language: 'Esperanto',
    })
    expect(other.tasks.every((task) => task.system?.includes('in Esperanto.'))).toBe(true)
    expect(
      other.tasks.every((task) =>
        task.system?.includes('give verdict, severity and category exactly'),
      ),
    ).toBe(true)
  })

  test('applies duplicates the verdict call names', async () => {
    const files = Array.from({ length: 25 }, (_, i) => diffFile(`mod${i % 2}/f${i}.ts`, 40))
    let area = 0
    const { agent } = fakeAgent({
      area: () => ({
        summary: 'S',
        findings: [
          draft(area++ === 0 ? 'Removes the widgets endpoint' : 'Gadget route dropped', {
            category: 'api',
            files: [{ path: `mod${area}/f.ts` }],
          }),
        ],
      }),
      verdict: () => ({ verdict: 'review', summary: 'S', duplicates: [{ finding: 2, sameAs: 1 }] }),
    })
    const data = await runUpgradeCheck({ ...run, agent, source: diffFilesSource(files) })
    expect(data.findings).toHaveLength(1)
    expect(data.findings[0]?.files).toHaveLength(2)
  })

  test('keeps the other areas when one fails and lists it as not checked', async () => {
    const files = Array.from({ length: 25 }, (_, i) => diffFile(`mod${i % 2}/f${i}.ts`, 40))
    const { agent } = fakeAgent({
      plan: () => new Error('plan down'),
      area: (task) =>
        task.prompt.includes('area 1 of')
          ? new Error('area down')
          : { summary: 'Fine.', findings: [] },
      verdict: () => new Error('verdict down'),
    })
    const logs: string[] = []
    const data = await runUpgradeCheck({
      ...run,
      agent,
      source: diffFilesSource(files),
      log: (line) => logs.push(line),
    })
    expect(data.verdict).toBe('review')
    expect(data.skipped).toEqual([
      { files: data.areas[0]?.files ?? -1, reason: `check of ${data.areas[0]?.name} failed` },
    ])
    expect(data.summary).toContain('**Not checked:**')
    expect(logs.some((line) => line.includes('plan down'))).toBe(true)
  })

  test('counts an area without a structured answer as not checked', async () => {
    const files = Array.from({ length: 25 }, (_, i) => diffFile(`mod${i % 2}/f${i}.ts`, 40))
    const { agent } = fakeAgent({
      area: (task) =>
        task.prompt.includes('area 1 of') ? undefined : { summary: 'Fine.', findings: [] },
      verdict: () => ({ verdict: 'safe', summary: 'Fine.' }),
    })
    const data = await runUpgradeCheck({ ...run, agent, source: diffFilesSource(files) })
    expect(data.verdict).toBe('review')
    expect(data.skipped).toHaveLength(1)
    expect(data.summary).toContain('**Not checked:**')
  })

  test('gives area passes a cost share, fenced diffs and the renamed files', async () => {
    const { agent, tasks } = fakeAgent({
      area: () => ({ summary: 'S', findings: [] }),
      verdict: () => ({ verdict: 'safe', summary: 'S' }),
    })
    await runUpgradeCheck({
      ...run,
      agent,
      costLimitUsd: 2,
      source: diffFilesSource([
        diffFile('src/a.ts'),
        { oldPath: 'conf/old.yaml', newPath: 'conf/new.yaml', status: 'renamed', diff: '' },
      ]),
    })
    const area = tasks.find((task) => task.taskKind === UPGRADE_CHECK_TASK_KIND)
    expect(area?.answerAtCostUsd).toBeCloseTo(1.7)
    expect(area?.trimToolResults).toBeDefined()
    expect(area?.prompt).toContain('```diff\n@@ -1 +1,5 @@')
    expect(area?.prompt).toContain('- conf/old.yaml → conf/new.yaml')
  })

  test('rejects when every area fails or a spend limit stops one', async () => {
    const files = [diffFile('src/a.ts')]
    const failing = fakeAgent({ area: () => new Error('down') })
    const error = await runUpgradeCheck({
      ...run,
      agent: failing.agent,
      source: diffFilesSource(files),
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('down')
    const budget = Object.assign(new Error('over budget'), { name: 'BudgetExceededError' })
    const stopped = fakeAgent({ area: () => budget })
    const stop = await runUpgradeCheck({
      ...run,
      agent: stopped.agent,
      source: diffFilesSource(files),
    }).catch((reason: unknown) => reason)
    expect(stop).toBe(budget)
  })

  test('marks the check capped when an area diff is cut', async () => {
    const huge = diffFile('src/huge.ts', 20_000)
    const { agent } = fakeAgent({
      area: () => ({ summary: 'S', findings: [] }),
      verdict: () => ({ verdict: 'safe', summary: 'S' }),
    })
    const data = await runUpgradeCheck({ ...run, agent, source: diffFilesSource([huge]) })
    expect(data.capped).toBe(true)
    expect(data.verdict).toBe('safe')
  })
})
