import { describe, expect, test } from 'bun:test'

import type { DiffFile, Discussion } from '@holtkeeper/forge'

import { findingMarker } from './dedupe.ts'
import {
  findingOrigins,
  findingOutcome,
  humanReplies,
  linesTouched,
  outcomeFields,
} from './outcome.ts'
import type { ReviewData, ReviewFinding } from './schema.ts'

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'f1',
  path: 'src/shape.ts',
  line: 10,
  severity: 'major',
  category: 'bug',
  title: 'Off by one',
  body: 'The loop skips the last item.',
  source: 'agent',
  posted: true,
  ...overrides,
})

const run = (overrides: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: 7,
    title: 'Add shapes',
    webUrl: 'https://gitlab.test/g/p/-/merge_requests/7',
    sourceBranch: 'feat/shapes',
    targetBranch: 'main',
    author: 'jane',
  },
  head: 'a'.repeat(40),
  mode: 'full',
  verdict: 'needs-changes',
  summary: '',
  comments: [finding()],
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 3,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  usage: { turns: 3, model: 'model-a' },
  promptVersion: 'p-1',
  ...overrides,
})

const change = (diff: string, extra: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: 'src/shape.ts',
  newPath: 'src/shape.ts',
  status: 'modified',
  diff,
  ...extra,
})

describe('findingOrigins', () => {
  test('keeps the first run that posted a finding, with its model and prompt version', () => {
    const first = run({ head: 'a'.repeat(40) })
    const second = run({
      head: 'b'.repeat(40),
      mode: 'incremental',
      usage: { turns: 1, model: 'model-b' },
      promptVersion: 'p-2',
      comments: [finding(), finding({ id: 'f2', line: 20 })],
    })
    const origins = findingOrigins([first, second])
    expect(origins.get('f1')).toMatchObject({
      head: 'a'.repeat(40),
      model: 'model-a',
      promptVersion: 'p-1',
    })
    expect(origins.get('f2')).toMatchObject({
      head: 'b'.repeat(40),
      model: 'model-b',
      promptVersion: 'p-2',
    })
  })

  test('ignores rejected comments and runs that reviewed nothing', () => {
    const origins = findingOrigins([
      run({ comments: [finding({ posted: false, error: 'line not in diff' })] }),
      run({ mode: 'skipped', verdict: 'skipped', comments: [finding({ id: 'f3' })] }),
    ])
    expect(origins.size).toBe(0)
  })

  test('leaves out what the run did not record', () => {
    const { usage: _usage, promptVersion: _version, ...bare } = run()
    const origin = findingOrigins([bare]).get('f1')
    expect(origin?.model).toBeUndefined()
    expect(origin?.promptVersion).toBeUndefined()
  })
})

describe('linesTouched', () => {
  test('a removed line inside the range counts, outside it does not', () => {
    const diff = '@@ -8,5 +8,5 @@\n a\n b\n-c\n+d\n e\n f\n'
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', line: 10 })).toBe(true)
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', line: 15 })).toBe(false)
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', startLine: 9, line: 12 })).toBe(
      true,
    )
  })

  test('lines added inside or next to the range count, far away ones do not', () => {
    // Adds two lines after old line 10.
    const diff = '@@ -9,3 +9,5 @@\n a\n b\n+guard\n+return\n c\n'
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', line: 10 })).toBe(true)
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', line: 9 })).toBe(false)
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', startLine: 3, line: 9 })).toBe(
      false,
    )
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', line: 30 })).toBe(false)
  })

  test('an addition before the first line of the range counts', () => {
    const diff = '@@ -9,2 +9,3 @@\n a\n+guard\n b\n'
    expect(linesTouched([change(diff)], { path: 'src/shape.ts', line: 10 })).toBe(true)
  })

  test('a file the commits do not touch is unchanged, a deleted one is touched', () => {
    expect(linesTouched([], { path: 'src/shape.ts', line: 10 })).toBe(false)
    expect(
      linesTouched([change('', { status: 'deleted' })], { path: 'src/shape.ts', line: 10 }),
    ).toBe(true)
  })

  test('a renamed file is found under its old path', () => {
    const diff = '@@ -10,1 +10,1 @@\n-x\n+y\n'
    const renamed = change(diff, { newPath: 'src/form.ts', status: 'renamed' })
    expect(linesTouched([renamed], { path: 'src/shape.ts', line: 10 })).toBe(true)
  })

  test('unknown when the forge left the diff out', () => {
    expect(
      linesTouched([change('', { collapsed: true })], { path: 'src/shape.ts', line: 10 }),
    ).toBeUndefined()
    expect(
      linesTouched([change('', { binary: true })], { path: 'src/shape.ts', line: 10 }),
    ).toBeUndefined()
  })
})

describe('findingOutcome', () => {
  test('changed lines win over the thread state', () => {
    expect(findingOutcome({ resolved: false, touched: true })).toBe('fixed')
    expect(findingOutcome({ resolved: true, touched: true })).toBe('fixed')
  })

  test('without a change the thread decides', () => {
    expect(findingOutcome({ resolved: true, touched: false })).toBe('resolved')
    expect(findingOutcome({ resolved: false, touched: false })).toBe('ignored')
  })

  test('without knowing the lines only a resolved thread is known', () => {
    expect(findingOutcome({ resolved: true, touched: undefined })).toBe('resolved')
    expect(findingOutcome({ resolved: false, touched: undefined })).toBe('unknown')
  })
})

const discussion = (
  notes: { author: string; body?: string; system?: boolean }[],
  resolved = false,
) =>
  ({
    id: 'd1',
    resolvable: true,
    resolved,
    notes: notes.map((note, index) => ({
      id: index + 1,
      author: note.author,
      body: note.body ?? 'text',
      createdAt: '',
      system: note.system ?? false,
    })),
  }) satisfies Discussion

describe('humanReplies', () => {
  test('counts notes of other people after the first, not ours nor system notes', () => {
    const thread = discussion([
      { author: 'holtkeeper-bot', body: `Problem\n\n${findingMarker('f1')}` },
      { author: 'jane' },
      { author: 'holtkeeper-bot', body: 'Still applies <!-- holtkeeper:review reply -->' },
      { author: 'sam' },
      { author: 'gitlab', system: true },
    ])
    expect(humanReplies(thread)).toBe(2)
    expect(humanReplies(thread, 'holtkeeper-bot')).toBe(2)
  })

  test('the bot account is ours even without a marker', () => {
    const thread = discussion([{ author: 'bot' }, { author: 'bot' }, { author: 'jane' }])
    expect(humanReplies(thread, 'bot')).toBe(1)
  })
})

describe('outcomeFields', () => {
  const thread = discussion([{ author: 'bot', body: findingMarker('f1') }, { author: 'jane' }])
  const origin = findingOrigins([run()]).get('f1')

  test('combines the outcome with where the finding came from', () => {
    const fields = outcomeFields({
      state: 'merged',
      discussion: thread,
      ...(origin ? { origin } : {}),
      changes: [change('@@ -10,1 +10,1 @@\n-x\n+y\n')],
    })
    expect(fields).toEqual({
      outcome: 'fixed',
      mergeRequestState: 'merged',
      humanReplies: 1,
      severity: 'major',
      source: 'agent',
      model: 'model-a',
      promptVersion: 'p-1',
    })
  })

  test('without a comparison an open thread stays unknown', () => {
    const fields = outcomeFields({
      state: 'closed',
      discussion: thread,
      ...(origin ? { origin } : {}),
    })
    expect(fields.outcome).toBe('unknown')
    expect(fields.mergeRequestState).toBe('closed')
  })

  test('without an origin only the thread speaks', () => {
    expect(outcomeFields({ state: 'merged', discussion: { ...thread, resolved: true } })).toEqual({
      outcome: 'resolved',
      mergeRequestState: 'merged',
      humanReplies: 1,
    })
  })
})
