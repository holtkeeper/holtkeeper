import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type { TestSuggestion } from '@holtkeeper/quality'

import { writeExampleTests } from './examples.ts'
import type { TestSetup } from './types.ts'

const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hk-examples-'))
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

/** An agent that answers each task with the next scripted answer and records the tasks. */
type Answer = object | Error | ((task: AgentTask) => Promise<object>)

function fakeAgent(answers: Answer[]) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'claude',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      const next = answers.shift()
      const value = typeof next === 'function' ? await next(task) : next
      if (value instanceof Error) throw value
      return { text: JSON.stringify(value), output: task.output?.parse(value), turns: 2 }
    },
  }
  return { agent, tasks }
}

const setup: TestSetup = {
  frameworks: [{ framework: 'bun:test', language: 'js', evidence: [] }],
  conventions: [
    {
      language: 'js',
      layout: 'colocated',
      fileName: '{name}.test.ts',
      frameworkImport: "import { expect, test } from 'bun:test'",
      localImportExtension: '.ts',
    },
  ],
  samples: ['src/math.test.ts'],
  testFiles: 1,
}

function suggestion(file: string, symbol: string): TestSuggestion {
  return {
    id: `id-${symbol}`,
    file,
    symbol,
    kind: 'function',
    range: { start: { line: 1, column: 1 }, end: { line: 5, column: 1 } },
    reason: `No test covers ${symbol}; 4 lines`,
  }
}

describe('writeExampleTests', () => {
  test('turns agent answers into review changes linked from suggestions', async () => {
    const dir = await project({ 'src/session.ts': 'export function createSession() {}\n' })
    const { agent, tasks } = fakeAgent([
      {
        path: 'src/session.test.ts',
        content: "import { test } from 'bun:test'\ntest('x', () => {})",
        notes: 'covers the happy path',
      },
    ])
    const result = await writeExampleTests({
      dir,
      agent,
      setup,
      suggestions: [
        suggestion('src/session.ts', 'createSession'),
        suggestion('src/other.ts', 'other'),
      ],
      count: 1,
    })

    expect(tasks).toHaveLength(1)
    const [task] = tasks
    expect(task?.capabilities).toEqual(['read', 'search'])
    expect(task?.dir).toBe(dir)
    expect(task?.prompt).toContain('`createSession` (function) in `src/session.ts` (lines 1–4)')
    expect(task?.prompt).toContain('src/math.test.ts')
    expect(task?.prompt).toContain("import { expect, test } from 'bun:test'")
    expect(task?.prompt).toContain('`src/session.test.ts`')
    expect(task?.prompt).toContain('Do not create or modify files')

    expect(result.failures).toEqual([])
    expect(result.changes).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        title: 'Add a test for createSession',
        description: 'covers the happy path',
        confidence: 'review',
        source: 'claude',
        edits: [
          {
            kind: 'create',
            file: 'src/session.test.ts',
            newText: "import { test } from 'bun:test'\ntest('x', () => {})\n",
          },
        ],
      },
    ])
    expect(result.suggestions[0]).toMatchObject({
      changeId: result.changes[0]?.id,
      testFile: 'src/session.test.ts',
      framework: 'bun:test',
    })
    expect(result.suggestions[1]?.changeId).toBeUndefined()
  })

  test('rejects paths that break the convention or exist, and agent failures', async () => {
    const dir = await project({
      'src/a.ts': '',
      'src/b.ts': '',
      'src/c.ts': '',
      'src/b.test.ts': 'existing',
    })
    const { agent } = fakeAgent([
      { path: 'test/a.test.ts', content: 'x', notes: '' },
      { path: 'src/b.test.ts', content: 'x', notes: '' },
      new Error('agent answer is not valid JSON'),
    ])
    const result = await writeExampleTests({
      dir,
      agent,
      setup,
      suggestions: [
        suggestion('src/a.ts', 'a'),
        suggestion('src/b.ts', 'b'),
        suggestion('src/c.ts', 'c'),
      ],
    })
    expect(result.changes).toEqual([])
    expect(result.failures.map((failure) => failure.error)).toEqual([
      'test path test/a.test.ts does not follow the project convention: tests live next to the source, in src',
      'test path src/b.test.ts already exists',
      'agent answer is not valid JSON',
    ])
  })

  test('verify grants run and removes the file the agent wrote to run the test', async () => {
    const dir = await project({ 'src/a.ts': 'export const a = 1\n' })
    const { agent, tasks } = fakeAgent([
      async (task: AgentTask) => {
        await writeFile(join(task.dir, 'src/a.test.ts'), 'scratch')
        return { path: './src/a.test.ts', content: 'final\n', notes: 'ran it: 1 pass' }
      },
    ])
    const result = await writeExampleTests({
      dir,
      agent,
      setup,
      suggestions: [suggestion('src/a.ts', 'a')],
      verify: true,
    })
    expect(tasks[0]?.capabilities).toEqual(['read', 'search', 'run'])
    expect(tasks[0]?.prompt).toContain('bun test ./src/a.test.ts')
    expect(result.changes[0]?.edits).toEqual([
      { kind: 'create', file: 'src/a.test.ts', newText: 'final\n' },
    ])
    expect(await Bun.file(join(dir, 'src/a.test.ts')).exists()).toBe(false)
  })

  test('skips targets in languages without a framework', async () => {
    const dir = await project({})
    const { agent, tasks } = fakeAgent([])
    const result = await writeExampleTests({
      dir,
      agent,
      setup,
      suggestions: [suggestion('main.go', 'main')],
    })
    expect(tasks).toEqual([])
    expect(result.failures[0]?.error).toContain('no test framework')
  })
})
