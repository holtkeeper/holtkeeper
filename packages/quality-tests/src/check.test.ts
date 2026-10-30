import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { createFakeRunner } from '@holtkeeper/exec/testing'

import { testGapsCheck } from './check.ts'

const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-check-'))
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
  'src/b.ts':
    'export function createSession(id: string) {\n  if (!id) throw new Error("id")\n  return { id }\n}\n',
  'src/a.test.ts':
    "import { expect, test } from 'bun:test'\nimport { a } from './a.ts'\ntest('a', () => expect(a(1)).toBe(2))\n",
}

const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,1\nDA:3,1\nLF:3\nLH:3\nend_of_record\n'

describe('testGapsCheck', () => {
  test('runs coverage and churn through the runner and suggests tests', async () => {
    const dir = await project(FILES)
    const { runner, calls } = createFakeRunner(async (command, { cwd }) => {
      if (command[0] === 'bun') {
        const out = command.find((arg) => arg.startsWith('--coverage-dir='))?.split('=')[1] ?? ''
        await writeFile(join(cwd, out, 'lcov.info'), LCOV)
        return { exitCode: 0 }
      }
      if (command[0] === 'git') return { stdout: 'src/b.ts\n\nsrc/b.ts\nsrc/a.ts\n' }
      return { exitCode: 1 }
    })
    const check = testGapsCheck()
    expect(check.name).toBe('tests')
    expect(await check.detect(dir)).toBe(true)
    const result = await check.run({ dir, runner })

    expect(calls.map((call) => call.command.slice(0, 2))).toEqual([
      ['bun', 'test'],
      ['git', 'log'],
    ])
    expect(calls[1]?.command).toContain('--since=90.days')
    expect(result.coverage).toEqual({ lines: { covered: 3, total: 3 } })
    expect(result.tests?.map((t) => [t.symbol, t.reason])).toEqual([
      [
        'createSession',
        'No test covers createSession; 4 lines, 1 branch, changed 2 times in 90 days',
      ],
    ])
    expect(result.changes).toEqual([])
    expect(await Bun.file(join(dir, '.holtkeeper')).exists()).toBe(false)
  })

  test('reads a coverage file and writes examples with the agent', async () => {
    const dir = await project({ ...FILES, 'coverage/lcov.info': LCOV })
    const { runner, calls } = createFakeRunner(() => ({
      exitCode: 128,
      stderr: 'not a git repository',
    }))
    const tasks: AgentTask[] = []
    const agent: Agent = {
      name: 'claude',
      async run<Output>(task: AgentTask<Output>) {
        tasks.push(task)
        const value = { path: 'src/b.test.ts', content: 'test', notes: '' }
        return { text: '', output: task.output?.parse(value), turns: 1 }
      },
    }
    const result = await testGapsCheck({
      coverage: { file: 'coverage/lcov.info' },
      examples: 1,
    }).run({ dir, runner, agent })
    expect(calls.map((call) => call.command[0])).toEqual(['git'])
    expect(tasks).toHaveLength(1)
    expect(result.tests?.[0]).toMatchObject({
      symbol: 'createSession',
      testFile: 'src/b.test.ts',
      changeId: result.changes?.[0]?.id,
    })
    expect(result.changes?.[0]?.source).toBe('claude')
  })

  test('fails when coverage cannot be collected', async () => {
    const dir = await project(FILES)
    const { runner } = createFakeRunner(() => ({ exitCode: 1, stderr: 'boom' }))
    expect(testGapsCheck().run({ dir, runner })).rejects.toThrow('bun test --coverage')
  })

  test('does not apply without a framework', async () => {
    const dir = await project({ 'README.md': '' })
    expect(await testGapsCheck().detect(dir)).toBe(false)
  })
})
