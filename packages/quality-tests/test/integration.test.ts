import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'

import { collectCoverage, coverageCollectors, detectTestSetup } from '../src/index.ts'

const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-tests-it-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const goTestFile = (pkg: string, fn: string) =>
  `package ${pkg}\n\nimport "testing"\n\nfunc Test${fn}(t *testing.T) {\n\tif ${fn}(2) != 4 {\n\t\tt.Fatal("bad")\n\t}\n}\n`

describe('coverage of real projects', () => {
  test.skipIf(!Bun.which('bun'))(
    'bun project: the untested module has no covered lines',
    async () => {
      const dir = await project({
        'package.json': JSON.stringify({
          name: 'shop',
          type: 'module',
          scripts: { test: 'bun test' },
        }),
        'src/math.ts': [
          'export function add(a: number, b: number): number {',
          '  const sum = a + b',
          '  return sum',
          '}',
          '',
          'export function clamp(value: number, max: number): number {',
          '  if (value > max) {',
          '    return max',
          '  }',
          '  return value',
          '}',
          '',
        ].join('\n'),
        'src/session.ts': [
          'export function createSession(user: string, ttlSeconds: number) {',
          "  if (!user) throw new Error('user is required')",
          '  const expiresAt = Date.now() + ttlSeconds * 1000',
          '  if (ttlSeconds <= 0 || ttlSeconds > 86400) {',
          "    throw new Error('ttl out of range')",
          '  }',
          '  return { user, expiresAt }',
          '}',
          '',
        ].join('\n'),
        'src/math.test.ts': [
          "import { expect, test } from 'bun:test'",
          '',
          "import { add } from './math.ts'",
          '',
          "test('add', () => {",
          '  expect(add(1, 2)).toBe(3)',
          '})',
          '',
        ].join('\n'),
      })

      const setup = await detectTestSetup(dir)
      expect(setup.frameworks[0]?.framework).toBe('bun:test')

      const report = await collectCoverage(await coverageCollectors(dir), {
        dir,
        runner: localRunner,
      })
      const math = report.files.find((file) => file.file === 'src/math.ts')
      expect(math?.lines.some((line) => line.hits > 0)).toBeTrue()
      const session = report.files.find((file) => file.file === 'src/session.ts')
      expect(session?.lines.every((line) => line.hits === 0) ?? true).toBeTrue()
      expect(report.summary.lines?.total).toBeGreaterThan(0)
    },
    60_000,
  )

  test.skipIf(!Bun.which('go'))(
    'go module: the untested function is not covered',
    async () => {
      const dir = await project({
        'go.mod': 'module example.com/shop\n\ngo 1.22\n',
        'calc/calc.go': [
          'package calc',
          '',
          'func Add(a, b int) int {',
          '\treturn a + b',
          '}',
          '',
          'func Discount(total int, vip bool) int {',
          '\tif vip && total > 100 {',
          '\t\treturn total - 10',
          '\t}',
          '\treturn total',
          '}',
          '',
        ].join('\n'),
        'calc/calc_test.go':
          'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
      })
      const report = await collectCoverage(await coverageCollectors(dir), {
        dir,
        runner: localRunner,
      })
      const calc = report.files.find((file) => file.file === 'calc/calc.go')
      expect(calc?.functions.find((fn) => fn.name === 'Discount')?.hits).toBe(0)
      expect(report.summary).toEqual({
        lines: { covered: 1, total: 4 },
        functions: { covered: 1, total: 2 },
      })
    },
    120_000,
  )

  test.skipIf(!Bun.which('go'))(
    'go.work: one run over every member module',
    async () => {
      const dir = await project({
        'go.work': 'go 1.22\n\nuse (\n\t./gear\n\t./cog\n)\n',
        'gear/go.mod': 'module example.com/acme/gear\n\ngo 1.22\n',
        'gear/gear.go': 'package gear\n\nfunc Spin(n int) int {\n\treturn n * 2\n}\n',
        'gear/gear_test.go': goTestFile('gear', 'Spin'),
        'cog/go.mod': 'module example.com/acme/cog\n\ngo 1.22\n',
        'cog/cog.go': 'package cog\n\nfunc Mesh(n int) int {\n\treturn n + 2\n}\n',
        'cog/cog_test.go': goTestFile('cog', 'Mesh'),
      })
      const report = await collectCoverage(await coverageCollectors(dir), {
        dir,
        runner: localRunner,
      })
      expect(report.notRun).toBeUndefined()
      expect(
        report.files
          .filter((file) => file.lines.some((line) => line.hits > 0))
          .map((file) => file.file)
          .toSorted(),
      ).toEqual(['cog/cog.go', 'gear/gear.go'])
    },
    120_000,
  )

  test.skipIf(!Bun.which('go'))(
    'go: packages that did not build are reported, tagged tests run only with tags',
    async () => {
      const dir = await project({
        'go.mod': 'module example.com/acme/widgets\n\ngo 1.22\n',
        'gear/gear.go': 'package gear\n\nfunc Spin(n int) int {\n\treturn n * 2\n}\n',
        'gear/gear_test.go':
          'package gear\n\nimport "testing"\n\nfunc TestSpin(t *testing.T) {\n\tif Spin(2) != 4 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
        'bolt/bolt.go': 'package bolt\n\nfunc Turn(n int) int {\n\treturn n + 1\n}\n',
        'bolt/bolt_test.go':
          '//go:build integration\n\npackage bolt\n\nimport "testing"\n\nfunc TestTurn(t *testing.T) {\n\tif Turn(1) != 2 {\n\t\tt.Fatal("bad")\n\t}\n}\n',
        'cog/cog.go': 'package cog\n\nfunc Mesh() int {\n\treturn 1\n}\n',
        'cog/cog_test.go':
          'package cog\n\nimport "testing"\n\nfunc TestMesh(t *testing.T) {\n\tMissing()\n}\n',
      })
      const lines: string[] = []
      const plain = await collectCoverage(await coverageCollectors(dir), {
        dir,
        runner: localRunner,
        log: (line) => lines.push(line),
      })
      expect(plain.notRun).toEqual([{ dir: 'cog', reason: 'build failed' }])
      expect(lines.some((line) => line.includes('integration (1)'))).toBe(true)
      expect(
        lines.some((line) => line.includes('example.com/acme/widgets/cog (build failed')),
      ).toBe(true)
      const bolt = (report: typeof plain) =>
        report.files
          .find((file) => file.file === 'bolt/bolt.go')
          ?.lines.some((line) => line.hits > 0)
      expect(bolt(plain)).toBeFalsy()

      const tagged = await collectCoverage(
        await coverageCollectors(dir, 'run', { go: { tags: ['integration'] } }),
        { dir, runner: localRunner },
      )
      expect(bolt(tagged)).toBe(true)
    },
    120_000,
  )
})
