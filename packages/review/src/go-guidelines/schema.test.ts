import { describe, expect, test } from 'bun:test'

import { goGuidelineSetOf, parseGoGuidelines } from './schema.ts'
import { BUNDLED_GO_GUIDELINES_TAG, bundledGoGuidelines } from './snapshot.ts'

const item = (id: string, since = '1.21', extra: Record<string, unknown> = {}) => ({
  id,
  since_version: since,
  guideline: `Use the ${id} helper.`,
  details: 'Shorter and clearer.',
  examples: [{ before: ['old()'], after: ['fresh()'] }],
  ...extra,
})

describe('parseGoGuidelines', () => {
  test('accepts the bundled snapshot', async () => {
    const set = await bundledGoGuidelines()
    expect(set.tag).toBe(BUNDLED_GO_GUIDELINES_TAG)
    expect(set.source).toBe('bundled')
    expect(set.guidelines.length).toBeGreaterThan(20)
    expect(set.guidelines.every((g) => /^\d+\.\d+$/.test(g.since_version))).toBe(true)
  })

  test('accepts the newer optional fields and drops unknown ones', () => {
    const [parsed] = parseGoGuidelines(
      JSON.stringify([
        item('widget_loop', '1.22', {
          modernizer: true,
          category: 'Loops',
          impact: 'Low',
          extra: 'x',
        }),
      ]),
    )
    expect(parsed).toMatchObject({ id: 'widget_loop', modernizer: true, impact: 'Low' })
    expect(parsed).not.toHaveProperty('extra')
  })

  test('rejects invalid collections', () => {
    expect(() => parseGoGuidelines('[]')).toThrow()
    expect(() => parseGoGuidelines('{')).toThrow()
    expect(() => parseGoGuidelines(JSON.stringify([item('a'), item('a')]))).toThrow(/unique/)
    expect(() => parseGoGuidelines(JSON.stringify([item('a', '1.21.3')]))).toThrow()
    expect(() => parseGoGuidelines(JSON.stringify([item('Bad-Id')]))).toThrow()
    expect(() => parseGoGuidelines(JSON.stringify([item('a', '1.21', { examples: [] })]))).toThrow()
    expect(() =>
      parseGoGuidelines(
        JSON.stringify([item('a', '1.21', { examples: [{ before: [' '], after: ['x'] }] })]),
      ),
    ).toThrow()
    expect(() =>
      parseGoGuidelines(JSON.stringify([item('a', '1.21', { guideline: 'x'.repeat(1001) })])),
    ).toThrow()
    expect(() => parseGoGuidelines(' '.repeat(1_000_001))).toThrow(/larger/)
  })
})

describe('goGuidelineSetOf', () => {
  test('reads a stored copy and rejects a broken one', () => {
    const stored = {
      tag: 'v0.2.0',
      fetchedAt: '2026-11-01T00:00:00.000Z',
      checkedAt: '2026-11-02T00:00:00.000Z',
      count: 1,
      guidelines: [item('widget_loop')],
    }
    expect(goGuidelineSetOf(stored)).toMatchObject({ tag: 'v0.2.0', source: 'github' })
    expect(goGuidelineSetOf({ ...stored, guidelines: [] })).toBeUndefined()
    expect(goGuidelineSetOf({ ...stored, tag: 'v0.2.0-dev.1' })).toBeUndefined()
    expect(goGuidelineSetOf(undefined)).toBeUndefined()
  })
})
