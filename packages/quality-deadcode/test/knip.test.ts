import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { type FileAccess, planChanges } from '@holtkeeper/changes'
import { localRunner } from '@holtkeeper/exec'

import { deadCodeCheck, knipFindings, parseKnipReport } from '../src/index.ts'
import { fixture } from './fixture.ts'

const memory = (files: Record<string, string>): FileAccess => ({
  read: async (file) => files[file],
})

const report = parseKnipReport(await Bun.file(join(import.meta.dir, 'knip-report.json')).text())

const summary = (issues: { file?: string; rule: string; message: string; severity: string }[]) =>
  issues
    .map((issue) => `${issue.file} ${issue.rule} ${issue.severity}: ${issue.message}`)
    .toSorted()

const expectedIssues = [
  'package.json deadcode/unused-dependency info: Unused dependency left-pad',
  'package.json deadcode/unused-dev-dependency info: Unused devDependency is-odd',
  'src/index.ts deadcode/unlisted-dependency warning: chalk is imported but not listed in package.json',
  'src/index.ts deadcode/unresolved-import warning: Cannot resolve import ./missing.ts',
  'src/orphan.ts deadcode/unused-file info: Unused file',
  'src/util.ts deadcode/duplicate-export info: The same value is exported as used, default',
  'src/util.ts deadcode/unused-enum-member info: Unused enum member Level.High',
  'src/util.ts deadcode/unused-export info: Unused export alias',
  'src/util.ts deadcode/unused-export info: Unused export default',
  'src/util.ts deadcode/unused-export info: Unused export local',
  'src/util.ts deadcode/unused-export info: Unused export other',
  'src/util.ts deadcode/unused-export info: Unused export unusedConst',
  'src/util.ts deadcode/unused-export info: Unused export unusedFn',
  'src/util.ts deadcode/unused-namespace-member info: Unused namespace member ns.dropped',
  'src/util.ts deadcode/unused-type info: Unused exported type Color',
  'src/util.ts deadcode/unused-type info: Unused exported type UnusedType',
]

test('parses a captured knip 6 report into issues', async () => {
  const { issues } = await knipFindings(report, memory(fixture))
  expect(summary(issues)).toEqual(expectedIssues)
  const left = issues.find((issue) => issue.message.endsWith('left-pad'))
  expect(left?.range).toEqual({ start: { line: 6, column: 6 }, end: { line: 6, column: 14 } })
  expect(issues.every((issue) => issue.tool === 'knip' && issue.category === 'lint')).toBe(true)
  expect(new Set(issues.map((issue) => issue.id)).size).toBe(issues.length)
})

test('proposes one review change per file, dependency and file with unused exports', async () => {
  const { issues, changes } = await knipFindings(report, memory(fixture))
  expect(changes.map((change) => change.title).toSorted()).toEqual([
    'Delete unused file src/orphan.ts',
    'Remove unused dependency left-pad',
    'Remove unused devDependency is-odd',
    'Stop exporting 7 unused exports in src/util.ts',
  ])
  expect(
    changes.every((change) => change.confidence === 'review' && change.source === 'knip'),
  ).toBe(true)
  const linked = new Set(issues.map((issue) => issue.changeId).filter(Boolean))
  expect(linked).toEqual(new Set(changes.map((change) => change.id)))
  expect(
    issues.find((issue) => issue.message === 'Unused export default')?.changeId,
  ).toBeUndefined()

  const plan = await planChanges(changes, memory(fixture))
  expect(plan.conflicts).toEqual([])
  const after = Object.fromEntries(plan.files.map((file) => [file.file, file.content]))
  expect(after['src/orphan.ts']).toBeUndefined()
  expect(JSON.parse(after['package.json'] ?? '')).toEqual({
    name: 'fixture',
    type: 'module',
    main: 'src/index.ts',
    dependencies: { zod: '^4.0.0' },
    devDependencies: {},
  })
  expect(after['src/util.ts']).toBe(`export function used() {
  return 1
}

export const helper = (a: unknown, b: unknown) => String(a) + String(b)

const unusedConst = 42

function unusedFn() {
  return 2
}

type UnusedType = { a: number }

enum Color {
  Red,
  Green,
}

const local = 1
const other = 2
export default used

export enum Level {
  Low,
  High,
}

export namespace ns {
  export const kept = 1
  export const dropped = 2
}
`)
})

test('every change also applies on its own', async () => {
  const { changes } = await knipFindings(report, memory(fixture))
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop
    const plan = await planChanges([change], memory(fixture))
    expect(plan.applied).toEqual([change.id])
    for (const file of plan.files.filter((entry) => entry.file.endsWith('.json')))
      expect(() => JSON.parse(file.content ?? '')).not.toThrow()
  }
})

const knip = join(import.meta.dir, '..', 'node_modules', 'knip', 'bin', 'knip.js')

test.skipIf(!(await Bun.file(knip).exists()))(
  'runs the real knip on the fixture',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quality-deadcode-'))
    try {
      for (const [file, content] of Object.entries(fixture)) {
        // oxlint-disable-next-line no-await-in-loop
        await mkdir(dirname(join(dir, file)), { recursive: true })
        // oxlint-disable-next-line no-await-in-loop
        await Bun.write(join(dir, file), content)
      }
      await mkdir(join(dir, 'node_modules'))
      const check = deadCodeCheck()
      expect(await check.detect(dir)).toBe(true)
      const result = await check.run({ dir, runner: localRunner })
      expect(result.version).toMatch(/^knip 6\./)
      expect(summary(result.issues ?? [])).toEqual(expectedIssues)
      expect(result.changes).toHaveLength(4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  60_000,
)
