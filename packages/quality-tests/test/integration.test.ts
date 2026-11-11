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
})
