import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { collectorFor } from './collect.ts'

const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quality-collect-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const outOf = (command: string[]) =>
  command.find((part) => part.startsWith('--coverageDirectory='))?.split('=')[1] ?? ''

test('runs package binaries from node_modules/.bin when present', async () => {
  await writeFile(join(dir, 'yarn.lock'), '')
  const { runner, calls } = createFakeRunner(() => ({ exitCode: 1 }))
  await collectorFor('jest', dir)
    .collect({ dir, runner })
    .catch(() => undefined)
  expect(calls[0]?.command.slice(0, 2)).toEqual(['yarn', 'jest'])

  await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true })
  await collectorFor('jest', dir)
    .collect({ dir, runner })
    .catch(() => undefined)
  expect(calls[1]?.command.slice(0, 6)).toEqual([
    'sh',
    '-c',
    'PATH="$PWD/node_modules/.bin:$PATH" exec "$@"',
    'sh',
    'jest',
    '--coverage',
  ])
})

test('finds a report written below the tool root and removes it', async () => {
  const { runner } = createFakeRunner(async (command) => {
    const report = join(dir, 'packages/app', outOf(command))
    await mkdir(report, { recursive: true })
    await writeFile(join(report, 'lcov.info'), LCOV)
    return { exitCode: 1 }
  })
  const report = await collectorFor('jest', dir).collect({ dir, runner })
  expect(report.files.map((file) => file.file)).toEqual(['src/a.ts'])
  const left = await Array.fromAsync(new Bun.Glob('**/coverage-*/**').scan({ cwd: dir, dot: true }))
  expect(left).toEqual([])
})

test('a missing report throws the command error', async () => {
  const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'boom' }))
  expect(collectorFor('jest', dir).collect({ dir, runner })).rejects.toThrow('jest --coverage')
})
