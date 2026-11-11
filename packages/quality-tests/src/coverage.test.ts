import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { collectCoverage, coverageCollectors } from './coverage.ts'

const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-coverage-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FILES = {
  'package.json': JSON.stringify({ scripts: { test: 'bun test' } }),
  'src/a.ts': 'export function a(x: number) {\n  const y = x + 1\n  return y\n}\n',
  'src/a.test.ts':
    "import { expect, test } from 'bun:test'\nimport { a } from './a.ts'\ntest('a', () => expect(a(1)).toBe(2))\n",
}

const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,1\nLF:3\nLH:3\nend_of_record\n'

describe('collectCoverage', () => {
  test('runs the detected framework through the runner and cleans up', async () => {
    const dir = await project(FILES)
    const { runner, calls } = createFakeRunner(async (command, { cwd }) => {
      const out = command.find((arg) => arg.startsWith('--coverage-dir='))?.split('=')[1] ?? ''
      await writeFile(join(cwd, out, 'lcov.info'), LCOV)
      return { exitCode: 0 }
    })
    const collectors = await coverageCollectors(dir)
    const report = await collectCoverage(collectors, { dir, runner })
    expect(calls.map((call) => call.command.slice(0, 2))).toEqual([['bun', 'test']])
    expect(report.summary).toEqual({ lines: { covered: 3, total: 3 } })
    expect(report.tools).toEqual([collectors[0]?.name ?? ''])
    expect(await Bun.file(join(dir, '.holtkeeper')).exists()).toBe(false)
  })

  test('reads a coverage file without running anything', async () => {
    const dir = await project({ ...FILES, 'coverage/lcov.info': LCOV })
    const { runner, calls } = createFakeRunner(() => ({ exitCode: 1 }))
    const report = await collectCoverage(
      await coverageCollectors(dir, { file: 'coverage/lcov.info' }),
      { dir, runner },
    )
    expect(calls).toEqual([])
    expect(report.files.map((file) => file.file)).toEqual(['src/a.ts'])
  })

  test('fails when no collector produced a report', async () => {
    const dir = await project(FILES)
    const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'boom' }))
    expect(collectCoverage(await coverageCollectors(dir), { dir, runner })).rejects.toThrow(
      'bun test --coverage',
    )
  })

  test('finds no collector without a framework', async () => {
    const dir = await project({ 'README.md': '' })
    expect(await coverageCollectors(dir)).toEqual([])
  })
})
