import { describe, expect, test } from 'bun:test'

import type { Agent } from '@holtkeeper/agent'

import { fakeAgent } from '../test/fakes.ts'
import {
  DEFAULT_SIZE_THRESHOLDS,
  adviceTexts,
  estimateReviewMinutes,
  formatDuration,
  logicalChanges,
  planSplit,
  reviewSizeLevel,
  sizeEscalated,
  sizedFiles,
} from './size.ts'

const code = (path: string, added: number, removed = 0) => ({ path, added, removed })
const lines = (kinds: ('add' | 'remove' | 'context')[]) => kinds.map((kind) => ({ kind, text: '' }))
const scoped = (path: string, changed: { kind: 'add' | 'remove' | 'context'; text: string }[]) => ({
  path,
  oldPath: path,
  status: 'modified' as const,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: changed }],
  lines: new Set<number>(),
  visible: new Map<number, string>(),
})

describe('estimateReviewMinutes', () => {
  test('nothing to review takes no time, anything else at least 5 minutes', () => {
    expect(estimateReviewMinutes({ files: [] })).toBe(0)
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 3)] })).toBe(5)
  })

  test('grows with lines, files and logical changes', () => {
    const small = estimateReviewMinutes({ files: [code('src/widget.ts', 300)] })
    const big = estimateReviewMinutes({ files: [code('src/widget.ts', 1200)] })
    expect(small).toBe(50)
    expect(big).toBeGreaterThan(small * 3)
    const spread = estimateReviewMinutes({
      files: Array.from({ length: 10 }, (_, i) => code(`src/part${i}.ts`, 30)),
      groups: 4,
    })
    expect(spread).toBeGreaterThan(small)
  })

  test('removed lines, tests and docs read faster', () => {
    const added = estimateReviewMinutes({ files: [code('src/widget.ts', 600)] })
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 0, 600)] })).toBeLessThan(added)
    expect(estimateReviewMinutes({ files: [code('src/widget.test.ts', 600)] })).toBeLessThan(added)
    expect(estimateReviewMinutes({ files: [code('pkg/shape_test.go', 600)] })).toBeLessThan(added)
    expect(estimateReviewMinutes({ files: [code('docs/guide.md', 600)] })).toBeLessThan(added)
  })

  test('stories read like tests', () => {
    const added = estimateReviewMinutes({ files: [code('src/Widget.tsx', 600)] })
    expect(estimateReviewMinutes({ files: [code('src/Widget.stories.tsx', 600)] })).toBeLessThan(
      added,
    )
  })

  test('repeated lines read faster', () => {
    const fresh = estimateReviewMinutes({ files: [code('src/widget.ts', 600)] })
    const mirrored = estimateReviewMinutes({
      files: [{ ...code('src/widget.ts', 600), repeatedAdded: 400 }],
    })
    expect(mirrored).toBeLessThan(fresh)
  })

  test('a file with a line or two changed costs less than a minute', () => {
    const tiny = Array.from({ length: 40 }, (_, i) => code(`src/shape${i}.ts`, 1))
    const small = Array.from({ length: 40 }, (_, i) => code(`src/shape${i}.ts`, 4))
    expect(estimateReviewMinutes({ files: tiny })).toBe(20)
    expect(estimateReviewMinutes({ files: small })).toBeGreaterThan(60)
  })

  test('logical changes past ten add nothing', () => {
    const files = [code('src/widget.ts', 100)]
    expect(estimateReviewMinutes({ files, groups: 30 })).toBe(
      estimateReviewMinutes({ files, groups: 10 }),
    )
    expect(estimateReviewMinutes({ files, groups: 10 })).toBeGreaterThan(
      estimateReviewMinutes({ files, groups: 2 }),
    )
  })

  test('the reading pace is configurable', () => {
    const files = [code('src/widget.ts', 600)]
    expect(estimateReviewMinutes({ files })).toBe(
      estimateReviewMinutes({ files, linesPerHour: 400 }),
    )
    expect(estimateReviewMinutes({ files, linesPerHour: 600 })).toBe(65)
    expect(estimateReviewMinutes({ files, linesPerHour: 200 })).toBe(180)
  })

  test('from two hours the estimate is rounded to half an hour', () => {
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 1000)] })).toBe(150)
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 3000)] }) % 30).toBe(0)
  })

  test('effort scales the reading time, neutral without it', () => {
    const files = [code('src/widget.ts', 600)]
    const neutral = estimateReviewMinutes({ files })
    expect(estimateReviewMinutes({ files, effort: 3 })).toBe(neutral)
    expect(estimateReviewMinutes({ files, effort: 1 })).toBeLessThan(neutral)
    expect(estimateReviewMinutes({ files, effort: 5 })).toBeGreaterThan(neutral)
  })
})

describe('levels and durations', () => {
  test('levels follow the thresholds', () => {
    expect(reviewSizeLevel(55, DEFAULT_SIZE_THRESHOLDS)).toBe('ok')
    expect(reviewSizeLevel(60, DEFAULT_SIZE_THRESHOLDS)).toBe('large')
    expect(reviewSizeLevel(120, DEFAULT_SIZE_THRESHOLDS)).toBe('too-large')
    expect(sizeEscalated('large')).toBe(true)
    expect(sizeEscalated('large', 'large')).toBe(false)
    expect(sizeEscalated('too-large', 'large')).toBe(true)
    expect(sizeEscalated('large', 'too-large')).toBe(false)
  })

  test('durations read naturally', () => {
    expect(formatDuration(25)).toBe('~25 min')
    expect(formatDuration(60)).toBe('~1 h')
    expect(formatDuration(130)).toBe('~2 h 10 min')
    const german = {
      locale: 'de',
      t: (key: string, params?: Record<string, string | number>) =>
        `${key}:${JSON.stringify(params)}`,
    } as never
    expect(formatDuration(130, german)).toBe('duration.hoursMinutes:{"hours":2,"minutes":10}')
  })

  test('only a too-large merge request gets the sentence about the limit', () => {
    expect(adviceTexts('large', 75).limit).toBeUndefined()
    expect(adviceTexts('large', 75).estimate).toContain('~1 h 15 min')
    expect(adviceTexts('too-large', 150).limit).toContain('more than a person can review')
    expect(adviceTexts('too-large', 150).ai).toStartWith('If this code is written by an AI agent')
  })

  test('sizedFiles counts added and removed lines of each file', () => {
    expect(
      sizedFiles([
        {
          path: 'src/widget.ts',
          oldPath: 'src/widget.ts',
          status: 'modified',
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 3,
              lines: lines(['context', 'add', 'add', 'remove']),
            },
          ],
          lines: new Set([2, 3]),
          visible: new Map(),
        },
      ]),
    ).toEqual([{ path: 'src/widget.ts', added: 2, removed: 1 }])
  })

  test('sizedFiles marks lines repeated from earlier files, short ones never', () => {
    const change = [
      { kind: 'add' as const, text: '  cullable={true}' },
      { kind: 'remove' as const, text: 'const speed = getSpeed(widget)' },
      { kind: 'add' as const, text: '}' },
      { kind: 'context' as const, text: 'return widget' },
    ]
    expect(
      sizedFiles([
        scoped('src/desktop/Widget.tsx', change),
        scoped('src/mobile/Widget.tsx', [
          ...change,
          { kind: 'add' as const, text: 'cullable={true}  ' },
          { kind: 'add' as const, text: 'const speed = getSpeed(widget)' },
        ]),
      ]),
    ).toEqual([
      { path: 'src/desktop/Widget.tsx', added: 2, removed: 1 },
      {
        path: 'src/mobile/Widget.tsx',
        added: 4,
        removed: 1,
        repeatedAdded: 2,
        repeatedRemoved: 1,
      },
    ])
  })

  test('logicalChanges joins walkthrough entries that share a file', () => {
    expect(logicalChanges([])).toBe(0)
    expect(
      logicalChanges([
        { files: ['src/live.ts', 'src/widget.ts'] },
        { files: ['src/gadget.ts'] },
        { files: ['src/live.ts'] },
        { files: ['src/gadget.ts', 'src/shape.ts'] },
        { files: ['src/shape.ts', 'src/widget.ts'] },
        { files: ['docs/guide.md'] },
      ]),
    ).toBe(2)
  })
})

describe('planSplit', () => {
  const files = [code('src/widget.ts', 400), code('src/gadget.ts', 300), code('docs/shapes.md', 50)]
  const texts = adviceTexts('too-large', 150)
  const base = {
    dir: '/checkout',
    mergeRequest: { title: 'Add widgets and gadgets', description: 'Adds both shapes.' },
    files,
    texts,
  }

  test('keeps known paths once each and takes the translated texts', async () => {
    const { agent, tasks } = fakeAgent({
      'review-split': [
        {
          splittable: true,
          reason: 'Widgets and gadgets are independent.',
          parts: [
            { title: 'Widgets', files: ['src/widget.ts', 'docs/shapes.md', 'src/ghost.ts'] },
            { title: 'Gadgets', files: ['src/gadget.ts', 'src/widget.ts'] },
            { title: 'Nothing known', files: ['src/ghost.ts'] },
          ],
          texts: { ...texts, ai: 'Translated AI note.', split: ' ' },
        },
      ],
    })
    const usage = { turns: 0 }
    const advice = await planSplit({ ...base, agent, usage, language: 'German' })
    expect(advice).toEqual({
      texts: { ...texts, ai: 'Translated AI note.' },
      splittable: true,
      reason: 'Widgets and gadgets are independent.',
      parts: [
        { title: 'Widgets', files: ['src/widget.ts', 'docs/shapes.md'] },
        { title: 'Gadgets', files: ['src/gadget.ts'] },
      ],
    })
    expect(tasks[0]).toMatchObject({ tier: 'fast', taskKind: 'review-split', capabilities: [] })
    expect(tasks[0]?.system).toContain('in German')
    expect(tasks[0]?.prompt).toContain('- src/widget.ts (+400 -0)')
    expect(usage.turns).toBe(2)
  })

  test('a single part is no plan; not splittable keeps the reason', async () => {
    const one = fakeAgent({
      'review-split': [
        {
          splittable: true,
          reason: 'x',
          parts: [{ title: 'All', files: ['src/widget.ts'] }],
          texts,
        },
      ],
    })
    expect(await planSplit({ ...base, agent: one.agent, usage: { turns: 0 } })).toEqual({
      texts,
      splittable: true,
    })
    const atomic = fakeAgent({
      'review-split': [{ splittable: false, reason: 'A mechanical rename.', parts: [], texts }],
    })
    const advice = await planSplit({ ...base, agent: atomic.agent, usage: { turns: 0 } })
    expect(advice).toEqual({ texts, splittable: false, reason: 'A mechanical rename.' })
    expect(atomic.tasks[0]?.system).toContain('language of the merge request description')
  })

  test('a failing call gives the English texts without a plan, an aborted one throws', async () => {
    const failing: Agent = {
      name: 'failing',
      run: async () => {
        throw new Error('provider down')
      },
    }
    expect(await planSplit({ ...base, agent: failing, usage: { turns: 0 } })).toEqual({
      texts,
      splittable: true,
    })
    const controller = new AbortController()
    controller.abort()
    expect(
      planSplit({ ...base, agent: failing, usage: { turns: 0 }, signal: controller.signal }),
    ).rejects.toThrow()
  })
})
