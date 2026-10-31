import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { deadCodeCheck, knipArgs, knipCommand } from './check.ts'

test('builds knip arguments from options', () => {
  expect(knipArgs({ production: true, include: ['files', 'exports'] })).toEqual([
    '--reporter',
    'json',
    '--no-exit-code',
    '--no-progress',
    '--production',
    '--include',
    'files,exports',
  ])
})

test('detects package.json and runs knip in the project directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quality-deadcode-check-'))
  try {
    const check = deadCodeCheck()
    expect(await check.detect(dir)).toBe(false)
    await Bun.write(join(dir, 'package.json'), '{\n  "dependencies": {\n    "a": "1"\n  }\n}\n')
    expect(await check.detect(dir)).toBe(true)
    expect(knipCommand(dir)[0]).toBe(process.execPath)
    await mkdir(join(dir, 'node_modules'))

    const { runner, calls } = createFakeRunner((command) =>
      command.includes('--version')
        ? { stdout: '6.44.0\n' }
        : {
            stdout: JSON.stringify({
              issues: [{ file: 'package.json', dependencies: [{ name: 'a', line: 3, col: 6 }] }],
            }),
          },
    )
    const result = await check.run({ dir, runner })
    expect(result.version).toBe('knip 6.44.0')
    expect(calls.every((call) => call.options.cwd === dir)).toBe(true)
    expect(result.issues?.map((issue) => issue.rule)).toEqual(['deadcode/unused-dependency'])
    expect(result.changes?.[0]?.edits[0]).toMatchObject({ kind: 'replace', newText: '' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('is skipped when declared dependencies are not installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quality-deadcode-check-'))
  try {
    await Bun.write(join(dir, 'package.json'), '{ "devDependencies": { "a": "1" } }')
    const { runner, calls } = createFakeRunner(() => ({ stdout: '' }))
    expect(await deadCodeCheck().run({ dir, runner })).toEqual({
      issues: [],
      changes: [],
      skipped: 'dependencies are not installed',
    })
    expect(calls).toHaveLength(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('fails on a non-zero exit', async () => {
  const { runner } = createFakeRunner((command) =>
    command.includes('--version')
      ? { stdout: '6.44.0' }
      : { exitCode: 2, stderr: 'Error loading knip.json' },
  )
  expect(deadCodeCheck().run({ dir: '/nowhere', runner })).rejects.toThrow(
    'knip exited with 2: Error loading knip.json',
  )
})
