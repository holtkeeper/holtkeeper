import { describe, expect, test } from 'bun:test'

import type { ReactionSignal } from '@holtkeeper/store'

import { type CitingRun, citedRules, ruleCitations, summarizeCitations } from './citations.ts'

const comment = (id: string, body: string, overrides: Record<string, unknown> = {}) => ({
  id,
  path: 'src/widget.ts',
  line: 3,
  severity: 'minor' as const,
  category: 'maintainability' as const,
  title: `Finding ${id}`,
  body,
  source: 'agent',
  posted: true,
  href: `https://forge.example/acme/round/web/-/merge_requests/7#note_${id}`,
  ...overrides,
})

const run = (
  mr: number,
  createdAt: string,
  comments: ReturnType<typeof comment>[],
  repo = 'work:acme/round/web',
): CitingRun => ({
  repo,
  createdAt,
  data: {
    mergeRequest: {
      id: mr,
      title: 'Add widget',
      webUrl: 'https://forge.example/acme/round/web/-/merge_requests/7',
      sourceBranch: 'feature/widget',
      targetBranch: 'main',
      author: 'jane',
    },
    comments,
  },
})

const signal = (findingId: string, overrides: Partial<ReactionSignal> = {}): ReactionSignal => ({
  repo: 'work:acme/round/web',
  mergeRequest: 7,
  noteId: `n-${findingId}`,
  category: 'maintainability',
  findingId,
  up: 0,
  down: 0,
  updatedAt: '2026-11-10T00:00:00.000Z',
  ...overrides,
})

describe('citedRules', () => {
  test('finds bracketed rule and learning citations once each, in order', () => {
    expect(
      citedRules('See [learn:abc-1] and [ rule: def2 ], again [learn:abc-1]; not learn:ghi.'),
    ).toEqual([
      { kind: 'learn', id: 'abc-1' },
      { kind: 'rule', id: 'def2' },
    ])
    expect(citedRules('nothing here [kb:old]')).toEqual([])
  })
})

describe('ruleCitations', () => {
  test('joins posted citing comments with their outcome', () => {
    const citations = ruleCitations(
      [
        run(7, '2026-11-01T00:00:00.000Z', [
          comment('f1', 'Register once [learn:k1].'),
          comment('f2', 'Per [learn:k1] and [rule:k2].'),
          comment('f3', 'No citation.'),
          comment('f4', 'Rejected [learn:k1].', { posted: false }),
          comment('f5', 'Merged, open thread [rule:k2].'),
        ]),
        // A later run of the same merge request repeats f1: it counts once, at the first run.
        run(7, '2026-11-02T00:00:00.000Z', [comment('f1', 'Register once [learn:k1].')]),
        run(9, '2026-11-03T00:00:00.000Z', [comment('f6', 'Still open [learn:k1].')]),
      ],
      [
        signal('f1', { mergeRequestState: 'merged', outcome: 'fixed', humanReplies: 1, up: 2 }),
        signal('f2', { mergeRequestState: 'merged', outcome: 'resolved', down: 1 }),
        signal('f5', { mergeRequestState: 'merged', outcome: 'ignored' }),
      ],
    )
    expect(citations.map((c) => [c.id, c.findingId, c.outcome, c.at.slice(0, 10)])).toEqual([
      ['k1', 'f6', 'open', '2026-11-03'],
      ['k1', 'f1', 'fixed', '2026-11-01'],
      ['k1', 'f2', 'resolved', '2026-11-01'],
      ['k2', 'f2', 'resolved', '2026-11-01'],
      ['k2', 'f5', 'dismissed', '2026-11-01'],
    ])
    expect(citations[1]).toMatchObject({
      replies: 1,
      up: 2,
      href: expect.stringContaining('note_f1'),
    })
  })

  test('closed merge requests and unknown outcomes are told apart', () => {
    const citations = ruleCitations(
      [run(7, '2026-11-01T00:00:00.000Z', [comment('a', '[learn:k]'), comment('b', '[learn:k]')])],
      [
        signal('a', { mergeRequestState: 'closed', outcome: 'ignored' }),
        signal('b', { mergeRequestState: 'merged', outcome: 'unknown' }),
      ],
    )
    expect(citations.map((c) => c.outcome)).toEqual(['closed', 'unknown'])
  })
})

describe('summarizeCitations', () => {
  test('counts outcomes, replies and reactions with the newest time', () => {
    const citations = ruleCitations(
      [
        run(7, '2026-11-01T00:00:00.000Z', [
          comment('f1', '[learn:k]'),
          comment('f2', '[learn:k]'),
        ]),
        run(9, '2026-11-04T00:00:00.000Z', [comment('f3', '[learn:k]')]),
      ],
      [
        signal('f1', { mergeRequestState: 'merged', outcome: 'resolved', humanReplies: 2, up: 1 }),
        signal('f2', { mergeRequestState: 'merged', outcome: 'ignored', down: 3 }),
      ],
    )
    expect(summarizeCitations(citations)).toEqual({
      comments: 3,
      fixed: 0,
      resolved: 1,
      dismissed: 1,
      open: 1,
      closed: 0,
      unknown: 0,
      replied: 1,
      up: 1,
      down: 3,
      lastCitedAt: '2026-11-04T00:00:00.000Z',
    })
    expect(summarizeCitations([])).toMatchObject({ comments: 0 })
    expect(summarizeCitations([]).lastCitedAt).toBeUndefined()
  })
})
