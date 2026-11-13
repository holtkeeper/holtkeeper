import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeCoverage } from './analyze.ts'
import { coverageReport, coverageTree } from './report.ts'

let dir: string

const LCOV = `TN:
SF:src/a.ts
FN:1,a
FNDA:2,a
DA:1,2
DA:2,2
DA:3,0
DA:4,1
BRDA:2,0,0,1
BRDA:2,0,1,0
end_of_record
SF:src/a.test.ts
DA:1,1
end_of_record
SF:src/gen/api.ts
DA:1,0
end_of_record
`

const files: Record<string, string> = {
  'coverage/lcov.info': LCOV,
  'src/a.ts': 'export const a = () => {\n  if (x) return 1\n  return 2\n}\n',
  'src/a.test.ts': "test('a', () => {})\n",
  'src/b.ts': 'export function b() {\n  return 1\n}\n',
  'src/types.ts': 'export interface T {\n  a: string\n}\n',
  'src/gen/api.ts': 'export const api = 1\n',
  'src/Badge.tsx': 'export function Badge() {\n  return <b />\n}\n',
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverage-'))
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), text)
  }
})

afterAll(() => rm(dir, { recursive: true, force: true }))

test('reads a coverage file per source file and adds files no test loaded', async () => {
  const { runner } = createFakeRunner(() => ({ exitCode: 1 }))
  const data = await analyzeCoverage({
    dir,
    runner,
    file: 'coverage/lcov.info',
    exclude: ['src/gen/**'],
  })
  expect(data.tools).toEqual(['coverage file coverage/lcov.info'])
  expect(data.languages).toEqual(['js'])
  expect(data.files).toEqual([
    {
      file: 'src/a.ts',
      lines: { covered: 3, total: 4 },
      functions: { covered: 1, total: 1 },
      branches: { covered: 1, total: 2 },
    },
    { file: 'src/b.ts', lines: { covered: 0, total: 3 }, loaded: false },
  ])
  expect(data.summary).toEqual({
    lines: { covered: 3, total: 7 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 2 },
  })

  const withoutUntested = await analyzeCoverage({
    dir,
    runner,
    file: 'coverage/lcov.info',
    untested: false,
  })
  expect(withoutUntested.files.map((file) => file.file)).toEqual(['src/a.ts', 'src/gen/api.ts'])
})

test('counts component files only with components', async () => {
  const { runner } = createFakeRunner(() => ({ exitCode: 1 }))
  const options = { dir, runner, file: 'coverage/lcov.info', exclude: ['src/gen/**'] }
  expect((await analyzeCoverage(options)).files.map((file) => file.file)).not.toContain(
    'src/Badge.tsx',
  )
  expect(
    (await analyzeCoverage({ ...options, components: true })).files.map((file) => file.file),
  ).toEqual(['src/a.ts', 'src/b.ts', 'src/Badge.tsx'])
})

test('throws when no collector produced a report', async () => {
  const { runner } = createFakeRunner(() => ({ exitCode: 1 }))
  expect(analyzeCoverage({ dir, runner, collectors: [] })).rejects.toThrow(
    'no coverage collector applies to this project',
  )
})

test('reports headline coverage, folders and changes', () => {
  const data = {
    tools: ['bun test --coverage'],
    languages: ['js'],
    summary: { lines: { covered: 30, total: 40 } },
    files: [
      { file: 'src/a.ts', lines: { covered: 30, total: 30 } },
      { file: 'src/lib/b.ts', lines: { covered: 0, total: 10 }, loaded: false as const },
    ],
  }
  const previous = {
    ...data,
    summary: { lines: { covered: 20, total: 40 } },
    files: [{ file: 'src/a.ts', lines: { covered: 20, total: 30 } }, data.files[1]!],
  }
  const report = coverageReport(data, {
    previous,
    compareTo: 'v1',
    generatedAt: '2026-10-30T00:00:00Z',
  })
  expect(report.metrics.map((m) => [m.id, m.value, m.delta, m.tone])).toEqual([
    ['lines', 75, 25, 'warning'],
    ['files', 2, 0, undefined],
    ['untested', 1, 0, 'warning'],
  ])
  expect(report.sections.map((s) => s.id)).toEqual(['overview', 'changes'])
  const table = report.sections[1]?.blocks[0]
  expect(table?.type === 'table' ? table.rows : []).toEqual([
    { file: 'src/a.ts', before: (20 / 30) * 100, after: 100, delta: 100 - (20 / 30) * 100 },
  ])
  expect(coverageTree(data.files)).toEqual({
    name: 'project',
    tone: 'warning',
    children: [
      {
        name: 'src',
        tone: 'warning',
        children: [
          { name: 'a.ts', value: 30, tone: 'good' },
          { name: 'lib', tone: 'bad', children: [{ name: 'b.ts', value: 10, tone: 'bad' }] },
        ],
      },
    ],
  })
})

test('go: skips the JavaScript steps without package.json and explains packages that did not run', async () => {
  const go = await mkdtemp(join(tmpdir(), 'coverage-go-'))
  try {
    const sources: Record<string, string> = {
      'go.mod': 'module example.com/acme/widgets\n',
      'gear/gear.go': 'package gear\n\nfunc Spin(n int) int {\n\treturn n * 2\n}\n',
      'cog/cog.go': 'package cog\n\nfunc Mesh() int {\n\treturn 1\n}\n',
      'tools/lint/lint.go': 'package lint\n\nfunc Run() int {\n\treturn 1\n}\n',
      'tools/lint/fmt/fmt.go': 'package fmt\n\nfunc Run() int {\n\treturn 1\n}\n',
    }
    for (const [file, text] of Object.entries(sources)) {
      await mkdir(dirname(join(go, file)), { recursive: true })
      await writeFile(join(go, file), text)
    }
    const { runner, calls } = createFakeRunner(() => ({ exitCode: 1 }))
    const lines: string[] = []
    const data = await analyzeCoverage({
      dir: go,
      runner,
      log: (line) => lines.push(line),
      collectors: [
        {
          name: 'go test -coverprofile',
          collect: async () => ({
            format: 'go',
            languages: ['go'],
            files: [
              {
                file: 'gear/gear.go',
                lines: [{ line: 4, hits: 1 }],
                functions: [],
                branches: [],
              },
            ],
            summary: {},
            notRun: [
              { dir: 'cog', reason: 'build failed' },
              { dir: 'tools', reason: 'setup failed', recursive: true, except: ['tools/lint/fmt'] },
            ],
          }),
        },
      ],
    })
    expect(calls).toEqual([])
    expect(lines).toEqual([])
    expect(data.files.map((file) => [file.file, file.reason])).toEqual([
      ['cog/cog.go', 'did not build'],
      ['gear/gear.go', undefined],
      ['tools/lint/fmt/fmt.go', undefined],
      ['tools/lint/lint.go', 'dependencies did not load'],
    ])
  } finally {
    await rm(go, { recursive: true, force: true })
  }
})
