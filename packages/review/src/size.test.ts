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
  type SizedFile,
  sizedFiles,
} from './size.ts'

const code = (path: string, added: number, removed = 0) => ({ path, added, removed })
const many = (n: number) => Array.from({ length: n }, (_, i) => code(`src/shape${i}.ts`, 0))
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
  test('nothing to review takes no time, anything else at least a minute', () => {
    expect(estimateReviewMinutes({ files: [] })).toBe(0)
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 1)], effort: 1 })).toBe(3)
    expect(
      estimateReviewMinutes({ files: [code('src/widget.ts', 0)], effort: 1, model: 'combined' }),
    ).toBeGreaterThanOrEqual(1)
  })

  test('the combined model adds understanding by effort, reading and files, to the minute', () => {
    // 10 to understand + 300 lines at 400 an hour (45) + half a minute for the file
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 300)] })).toBe(56)
    // effort 2: 5 + 6 lines × 0.5 at 400 an hour (0.45) + 3 files (1.5)
    expect(
      estimateReviewMinutes({
        files: [code('src/a.ts', 2), code('src/b.ts', 2), code('src/c.ts', 2)],
        effort: 2,
      }),
    ).toBe(7)
    const files = [code('src/widget.ts', 600)]
    expect(estimateReviewMinutes({ files, effort: 3 })).toBe(estimateReviewMinutes({ files }))
    expect(estimateReviewMinutes({ files, effort: 1 })).toBeLessThan(
      estimateReviewMinutes({ files }),
    )
    expect(estimateReviewMinutes({ files, effort: 5 })).toBeGreaterThan(
      estimateReviewMinutes({ files }),
    )
  })

  test('the agent model takes the agent estimate within a third and twice the combined one', () => {
    const files = [code('src/widget.ts', 300)]
    const combined = estimateReviewMinutes({ files, model: 'combined' })
    expect(combined).toBe(56)
    expect(estimateReviewMinutes({ files })).toBe(combined)
    expect(estimateReviewMinutes({ files, agentMinutes: 30 })).toBe(30)
    expect(estimateReviewMinutes({ files, agentMinutes: 2 })).toBe(19)
    expect(estimateReviewMinutes({ files, agentMinutes: 500 })).toBe(111)
    expect(estimateReviewMinutes({ files, model: 'combined', agentMinutes: 30 })).toBe(combined)
  })

  test('styles, config and data read like docs', () => {
    const model = 'psp' as const
    const logic = estimateReviewMinutes({ files: [code('src/ui/Widget.tsx', 300)], model })
    for (const path of [
      'src/ui/Widget/styled.ts',
      'src/ui/Widget/styles.ts',
      'src/ui/Widget.styles.ts',
      'src/ui/widget.css.ts',
      'src/ui/widget.module.scss',
      'config/app.yaml',
      'src/locales/en/common.ts',
      'package.json',
    ])
      expect(estimateReviewMinutes({ files: [code(path, 300)], model })).toBeLessThan(logic / 2)
  })

  test('files past thirty add nothing in the combined model', () => {
    expect(estimateReviewMinutes({ files: many(60) })).toBe(
      estimateReviewMinutes({ files: many(30) }),
    )
  })

  test('line-based models read at their own pace and ignore effort', () => {
    const files = [code('src/widget.ts', 500)]
    expect(estimateReviewMinutes({ files, model: 'smartbear' })).toBe(66)
    expect(estimateReviewMinutes({ files, model: 'psp' })).toBe(156)
    expect(estimateReviewMinutes({ files, model: 'psp', effort: 1 })).toBe(156)
  })

  test('the effort tiers model ignores size', () => {
    const model = 'effort-tiers' as const
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 5)], effort: 2, model })).toBe(10)
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 5000)], effort: 2, model })).toBe(
      10,
    )
    expect(estimateReviewMinutes({ files: [code('src/widget.ts', 5)], model })).toBe(25)
  })

  test('removed lines, repeated lines, tests, stories and docs read faster', () => {
    const model = 'psp' as const
    const added = estimateReviewMinutes({ files: [code('src/widget.ts', 600)], model })
    const faster = (file: SizedFile) =>
      expect(estimateReviewMinutes({ files: [file], model })).toBeLessThan(added)
    faster(code('src/widget.ts', 0, 600))
    faster({ ...code('src/widget.ts', 600), repeatedAdded: 400 })
    faster(code('src/widget.test.ts', 600))
    faster(code('src/Widget.stories.tsx', 600))
    faster(code('pkg/shape_test.go', 600))
    faster(code('docs/guide.md', 600))
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

  test('judges whether to split, without a plan, and takes the translated texts', async () => {
    const { agent, tasks } = fakeAgent({
      'review-split': [
        {
          splittable: true,
          reason: '',
          direction: ' Ship the widget model first, then the gadget screens on top of it. ',
          texts: { ...texts, ai: 'Translated AI note.', split: ' ' },
        },
      ],
    })
    const usage = { turns: 0 }
    const advice = await planSplit({ ...base, agent, usage, language: 'German' })
    expect(advice).toEqual({ texts: { ...texts, ai: 'Translated AI note.' }, splittable: true })
    expect(tasks[0]).toMatchObject({ tier: 'fast', taskKind: 'review-split', capabilities: [] })
    expect(tasks[0]?.system).toContain('in German')
    expect(tasks[0]?.system).not.toContain('direction')
    expect(tasks[0]?.prompt).toContain('- src/widget.ts (+400 -0)')
    expect(usage.turns).toBe(2)
  })

  test('a direction in the answer is ignored; not splittable keeps the reason', async () => {
    const empty = fakeAgent({
      'review-split': [{ splittable: true, reason: 'x', direction: ' ', texts }],
    })
    expect(await planSplit({ ...base, agent: empty.agent, usage: { turns: 0 } })).toEqual({
      texts,
      splittable: true,
    })
    const atomic = fakeAgent({
      'review-split': [
        { splittable: false, reason: 'A mechanical rename.', direction: 'ignored', texts },
      ],
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
