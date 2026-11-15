import { describe, expect, test } from 'bun:test'

import type { ReactionSignal } from '@holtkeeper/store'

import { type CitingRun, citedIds, knowledgeCitations, summarizeCitations } from './citations.ts'

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

describe('citedIds', () => {
  test('finds bracketed citations once each, in order', () => {
    expect(citedIds('See [kb:abc-1] and [ kb: def2 ], again [kb:abc-1]; not kb:ghi.')).toEqual([
      'abc-1',
      'def2',
    ])
    expect(citedIds('nothing here')).toEqual([])
  })
})

describe('knowledgeCitations', () => {
  test('joins posted citing comments with their outcome', () => {
    const citations = knowledgeCitations(
      [
        run(7, '2026-11-01T00:00:00.000Z', [
          comment('f1', 'Register once [kb:k1].'),
          comment('f2', 'Per [kb:k1] and [kb:k2].'),
          comment('f3', 'No citation.'),
          comment('f4', 'Rejected [kb:k1].', { posted: false }),
          comment('f5', 'Merged, open thread [kb:k2].'),
        ]),
        // A later run of the same merge request repeats f1: it counts once, at the first run.
        run(7, '2026-11-02T00:00:00.000Z', [comment('f1', 'Register once [kb:k1].')]),
        run(9, '2026-11-03T00:00:00.000Z', [comment('f6', 'Still open [kb:k1].')]),
      ],
      [
        signal('f1', { mergeRequestState: 'merged', outcome: 'fixed', humanReplies: 1, up: 2 }),
        signal('f2', { mergeRequestState: 'merged', outcome: 'resolved', down: 1 }),
        signal('f5', { mergeRequestState: 'merged', outcome: 'ignored' }),
      ],
    )
    expect(citations.map((c) => [c.entry, c.findingId, c.outcome, c.at.slice(0, 10)])).toEqual([
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
    const citations = knowledgeCitations(
      [run(7, '2026-11-01T00:00:00.000Z', [comment('a', '[kb:k]'), comment('b', '[kb:k]')])],
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
    const citations = knowledgeCitations(
      [
        run(7, '2026-11-01T00:00:00.000Z', [comment('f1', '[kb:k]'), comment('f2', '[kb:k]')]),
        run(9, '2026-11-04T00:00:00.000Z', [comment('f3', '[kb:k]')]),
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
