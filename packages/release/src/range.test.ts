import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type { DiffFile } from '@holtkeeper/forge'

import { isRangeNoise, rangeCodeDiff, writeRangeSummary } from './range.ts'
import { writeSummary } from './summary.ts'
import type { ReleaseEntry } from './types.ts'

const file = (path: string, diff: string, extra: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: path,
  newPath: path,
  status: 'modified',
  diff,
  ...extra,
})

const entry = (text: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  id: text,
  section: 'features',
  type: 'feat',
  breaking: false,
  bump: 'minor',
  title: text,
  text,
  tickets: [],
  mergeRequests: [],
  commits: [
    {
      sha: 'abc1234',
      subject: `feat: ${text}`,
      author: 'Ada',
      date: '2026-01-02',
    },
  ],
  authors: ['Ada'],
  included: true,
  ...extra,
})

function fakeAgent(output: unknown) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    run: async (task) => {
      tasks.push(task)
      return { text: '', output: output as never, turns: 1 }
    },
  }
  return { agent, tasks }
}

describe('rangeCodeDiff', () => {
  test('drops noise and orders source, other, tests, docs', () => {
    const result = rangeCodeDiff([
      file('docs/guide.md', '+doc'),
      file('src/widget.test.ts', '+test'),
      file('pnpm-lock.yaml', '+lock'),
      file('go.sum', '+sum'),
      file('assets/logo.png', '', { binary: true }),
      file('src/huge.ts', '', { collapsed: true }),
      file('node_modules/some-lib/index.js', '+vendored'),
      file('public/app.min.js', '+min'),
      file('src/__snapshots__/widget.test.ts.snap', '+snap'),
      file('config.yaml', '+config'),
      file('src/widget.ts', '+a longer source change'),
      file('src/shape.ts', '+short'),
      file('src/old.ts', '-gone', { status: 'deleted', newPath: 'src/old.ts' }),
    ])
    expect(result.files.map((f) => f.path)).toEqual([
      'src/old.ts',
      'src/shape.ts',
      'src/widget.ts',
      'config.yaml',
      'src/widget.test.ts',
      'docs/guide.md',
    ])
    expect(result.omitted).toBe(7)
    expect(result.truncated).toBe(false)
  })

  test('uses the old path of deleted files', () => {
    const result = rangeCodeDiff([
      file('x', '-gone', {
        status: 'deleted',
        oldPath: 'src/foo-util.ts',
        newPath: '/dev/null',
      }),
    ])
    expect(result.files).toEqual([{ path: 'src/foo-util.ts', status: 'deleted', diff: '-gone' }])
  })

  test('cuts the file that does not fit and omits the rest', () => {
    const result = rangeCodeDiff(
      [
        file('src/a.ts', 'a'.repeat(1000)),
        file('src/b.ts', 'b'.repeat(3000)),
        file('src/c.ts', 'c'.repeat(5000)),
      ],
      { maxChars: 2500 },
    )
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.files[1]?.diff.startsWith('b'.repeat(1500))).toBe(true)
    expect(result.files[1]?.diff).toContain('(diff cut)')
    expect(result.omitted).toBe(1)
    expect(result.truncated).toBe(true)
  })
})

describe('isRangeNoise', () => {
  test('flags lockfiles, generated and vendored files but not source', () => {
    expect(isRangeNoise('bun.lock')).toBe(true)
    expect(isRangeNoise('web/vendor/some-lib/index.js')).toBe(true)
    expect(isRangeNoise('api/widget.pb.go')).toBe(true)
    expect(isRangeNoise('src/widget.ts')).toBe(false)
  })
})

describe('writeRangeSummary', () => {
  test('a fast call over the entries only', async () => {
    const { agent, tasks } = fakeAgent({
      overview: 'Widgets got faster.',
      highlights: ['Widget rendering is faster.'],
      check: ['Open a widget.'],
    })
    const markdown = await writeRangeSummary(agent, {
      entries: [entry('faster widgets'), entry('hidden', { included: false })],
      from: '1.0.0',
      to: '1.1.0',
    })
    expect(markdown).toBe(
      'Widgets got faster.\n\n**Highlights**\n\n- Widget rendering is faster.\n\n**What to check**\n\n- Open a widget.',
    )
    const task = tasks[0]
    expect(task?.tier).toBe('fast')
    expect(task?.taskKind).toBe('release-notes')
    expect(task?.capabilities).toEqual([])
    expect(task?.prompt).toContain('from 1.0.0 to 1.1.0')
    expect(task?.prompt).toContain('faster widgets')
    expect(task?.prompt).not.toContain('hidden')
    expect(task?.prompt).not.toContain('Code diff')
    expect(task?.system).toContain('Write the prose in English.')
  })

  test('writes the prose in the asked language', async () => {
    const { agent, tasks } = fakeAgent({ overview: 'O', highlights: [], check: [] })
    await writeRangeSummary(agent, {
      entries: [entry('dials')],
      to: '1.1.0',
      language: 'Esperanto',
    })
    expect(tasks[0]?.system).toContain('Write the prose in Esperanto.')
    expect(tasks[0]?.system).toContain('package names, file paths')
  })

  test('uses the section headings the agent wrote in its language, English for any gap', async () => {
    const { agent } = fakeAgent({
      headings: { highlights: 'Saliento', check: '' },
      overview: 'O',
      highlights: ['Ciferdiskoj'],
      check: ['Turnu ĝin'],
    })
    const markdown = await writeRangeSummary(agent, {
      entries: [entry('dials')],
      to: '1.1.0',
      language: 'Esperanto',
    })
    expect(markdown).toContain('**Saliento**')
    expect(markdown).toContain('**What to check**')
  })

  test('code and dependencies add sections and use the main tier', async () => {
    const { agent, tasks } = fakeAgent({
      overview: 'Shapes changed.',
      highlights: [],
      codeChanges: ['ShapeBase caches its bounds.'],
      dependencies: ['some-lib moved to 2.0.0.'],
      check: [],
    })
    const markdown = await writeRangeSummary(agent, {
      entries: [entry('shape bounds')],
      to: 'main',
      code: {
        files: [{ path: 'src/shape.ts', status: 'modified', diff: '+cache' }],
        omitted: 2,
        truncated: true,
      },
      dependencies: '- some-lib 1.4.0 → 2.0.0',
    })
    expect(markdown).toBe(
      'Shapes changed.\n\n**Code changes**\n\n- ShapeBase caches its bounds.\n\n**Dependencies**\n\n- some-lib moved to 2.0.0.',
    )
    const task = tasks[0]
    expect(task?.tier).toBe('main')
    expect(task?.prompt).toContain('up to main')
    expect(task?.prompt).toContain('--- src/shape.ts (modified)\n+cache')
    expect(task?.prompt).toContain('2 more left out')
    expect(task?.prompt).toContain('some-lib 1.4.0 → 2.0.0')
  })

  test('rejects without a structured answer', async () => {
    const { agent } = fakeAgent(undefined)
    const error: unknown = await writeRangeSummary(agent, { entries: [], to: '1.0.0' }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)
  })
})

describe('writeSummary', () => {
  test('writes the prose in the asked language, English by default', async () => {
    const { agent, tasks } = fakeAgent({ overview: 'O', highlights: [], check: [] })
    await writeSummary(agent, [entry('dials')], { version: '1.1.0' })
    await writeSummary(agent, [entry('dials')], { version: '1.1.0', language: 'Esperanto' })
    expect(tasks[0]?.system).toContain('Write the prose in English.')
    expect(tasks[1]?.system).toContain('Write the prose in Esperanto.')
  })
})
