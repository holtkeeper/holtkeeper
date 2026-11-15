import { describe, expect, test } from 'bun:test'

import type { ReactionSignal } from '@holtkeeper/store'

import { qualityRows } from './quality.ts'

const signal = (overrides: Partial<ReactionSignal>): ReactionSignal => ({
  repo: 'work:games/arcade',
  mergeRequest: 1,
  noteId: '1',
  category: 'bug',
  up: 0,
  down: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
  outcome: 'fixed',
  mergeRequestState: 'merged',
  ...overrides,
})

describe('qualityRows', () => {
  test('groups merged comments and computes acceptance over judged ones', () => {
    const { rows, total } = qualityRows(
      [
        signal({ noteId: '1', outcome: 'fixed', up: 2 }),
        signal({ noteId: '2', outcome: 'fixed' }),
        signal({ noteId: '3', outcome: 'resolved' }),
        signal({ noteId: '4', outcome: 'ignored', down: 1 }),
        signal({ noteId: '5', outcome: 'unknown' }),
        signal({ noteId: '6', category: 'style', outcome: 'ignored' }),
      ],
      'category',
    )
    expect(rows.map((row) => row.key)).toEqual(['bug', 'style'])
    expect(rows[0]).toEqual({
      key: 'bug',
      comments: 5,
      fixed: 2,
      resolved: 1,
      ignored: 1,
      unknown: 1,
      up: 2,
      down: 1,
      acceptance: 0.5,
      addressed: 0.75,
    })
    expect(rows[1]).toMatchObject({ key: 'style', acceptance: 0, addressed: 0 })
    expect(total).toMatchObject({ comments: 6, fixed: 2, resolved: 1, ignored: 2, unknown: 1 })
  })

  test('skips closed merge requests and signals without an outcome', () => {
    const { rows, total } = qualityRows(
      [
        signal({ mergeRequestState: 'closed' }),
        (({ outcome: _outcome, ...rest }) => rest)(signal({})),
        signal({ noteId: '9' }),
      ],
      'category',
    )
    expect(rows).toHaveLength(1)
    expect(total.comments).toBe(1)
  })

  test('has no acceptance when nothing is judged', () => {
    const { rows } = qualityRows([signal({ outcome: 'unknown' })], 'category')
    expect(rows[0]).not.toHaveProperty('acceptance')
  })

  test('groups by model and prompt version, naming what is missing unknown', () => {
    const signals = [
      signal({ noteId: '1', model: 'model-a', promptVersion: 'p-1' }),
      signal({ noteId: '2', model: 'model-a', promptVersion: 'p-2' }),
      signal({ noteId: '3', model: 'model-b' }),
    ]
    expect(qualityRows(signals, 'model').rows.map((r) => [r.key, r.comments])).toEqual([
      ['model-a', 2],
      ['model-b', 1],
    ])
    expect(qualityRows(signals, 'promptVersion').rows.map((r) => r.key)).toEqual([
      'p-1',
      'p-2',
      'unknown',
    ])
  })

  test('is empty without signals', () => {
    const { rows, total } = qualityRows([], 'severity')
    expect(rows).toEqual([])
    expect(total.comments).toBe(0)
  })
})
