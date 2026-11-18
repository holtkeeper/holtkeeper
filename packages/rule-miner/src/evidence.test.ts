import { describe, expect, test } from 'bun:test'

import {
  COMMENTS_CHARS,
  collectReviewComments,
  isBot,
  isDependencyUpdate,
  linesTouched,
  noteUrl,
} from './evidence.ts'
import { at, fakeForge, mergeRequest, note, replacing, thread } from './test-helpers.ts'

const repo = { forge: 'gitlab', path: 'acme/widgets' }
const since = new Date('2026-09-01T00:00:00.000Z')

describe('linesTouched', () => {
  const changes = replacing(10, 'src/a.ts')

  test('a removed line near the commented one counts, a far one does not', () => {
    expect(linesTouched(changes, 'src/a.ts', 10)).toBe(true)
    expect(linesTouched(changes, 'src/a.ts', 12)).toBe(true)
    expect(linesTouched(changes, 'src/a.ts', 30)).toBe(false)
    expect(linesTouched(changes, 'src/other.ts', 10)).toBe(false)
  })

  test('an added line right after the range counts', () => {
    const added = [
      {
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        status: 'modified' as const,
        diff: '@@ -5,2 +5,3 @@\n one\n+guard\n two\n',
      },
    ]
    expect(linesTouched(added, 'src/a.ts', 7)).toBe(true)
    expect(linesTouched(added, 'src/a.ts', 20)).toBe(false)
  })

  test('a deleted file counts, a collapsed diff is unknown', () => {
    expect(
      linesTouched([{ oldPath: 'x.ts', newPath: 'x.ts', status: 'deleted', diff: '' }], 'x.ts', 3),
    ).toBe(true)
    expect(
      linesTouched(
        [{ oldPath: 'x.ts', newPath: 'x.ts', status: 'modified', diff: '', collapsed: true }],
        'x.ts',
        3,
      ),
    ).toBeUndefined()
  })
})

describe('helpers', () => {
  test('bots, dependency updates and note links', () => {
    expect(isBot('renovate-bot')).toBe(true)
    expect(isBot('holt', 'holt')).toBe(true)
    expect(isBot('dev-two')).toBe(false)
    expect(isDependencyUpdate('chore(deps): update some-lib to v2')).toBe(true)
    expect(isDependencyUpdate('Add widget panel')).toBe(false)
    expect(noteUrl('https://forge.test/acme/widgets/-/merge_requests/3', 9)).toBe(
      'https://forge.test/acme/widgets/-/merge_requests/3#note_9',
    )
    expect(noteUrl('https://forge.test/acme/widgets/pull/3', 9)).toBe(
      'https://forge.test/acme/widgets/pull/3#discussion_r9',
    )
  })
})

describe('collectReviewComments', () => {
  test('keeps reviewer comments that led to a change, best first, with sources', async () => {
    const { forge, calls } = fakeForge(
      [
        mergeRequest(12),
        mergeRequest(13),
        mergeRequest(14, { author: 'renovate-bot' }),
        mergeRequest(15, { title: 'chore(deps): update some-lib' }),
        mergeRequest(5, { mergedAt: '2026-08-01T00:00:00.000Z' }),
      ],
      {
        13: [
          thread('d-changed', [note('n1', 'dev-two', 'Use the size guard here.')], {
            position: at('src/panel.ts', 10),
          }),
          thread('d-untouched', [note('n2', 'dev-two', 'Rename this?')], {
            resolved: true,
            position: at('src/panel.ts', 40),
          }),
          thread('d-own', [note('n3', 'dev-one', 'Note to self.')], { resolved: true }),
          thread('d-bot', [note('n4', 'holt', 'Bot finding.')], { resolved: true }),
          thread('d-open', [note('n5', 'dev-three', 'Maybe later.')]),
        ],
        12: [
          thread('d-ack', [
            note('n6', 'dev-three', 'Keep changelog lines short.'),
            note('n7', 'dev-one', 'Done, thanks'),
          ]),
          thread('d-resolved', [note('n8', 'dev-two', 'Prefer named exports.')], {
            resolved: true,
          }),
          thread('d-system', [note('n9', 'dev-two', 'changed this line', true)], {
            resolved: true,
          }),
        ],
      },
      replacing(10, 'src/panel.ts'),
    )
    const result = await collectReviewComments({
      forge,
      repo,
      since,
      maxMergeRequests: 50,
      discussionMergeRequests: 10,
      botUsername: 'holt',
    })
    expect(result.listed).toBe(true)
    expect(result.mergeRequests.map((mr) => mr.id)).toEqual([13, 12])
    expect(result.discussions).toBe(2)
    expect(result.threads).toBe(5)
    expect(
      result.comments.map((comment) => [comment.id, comment.signal, comment.source.noteId]),
    ).toEqual([
      ['c1', 'changed', 'n1'],
      ['c2', 'acknowledged', 'n6'],
      ['c3', 'resolved', 'n8'],
    ])
    expect(result.comments[0]).toMatchObject({
      path: 'src/panel.ts',
      line: 10,
      text: 'src/panel.ts:10 reviewer 1: Use the size guard here.',
      source: {
        repo: 'gitlab:acme/widgets',
        mergeRequest: 13,
        discussionId: 'd-changed',
        author: 'dev-two',
        at: '2026-10-05T00:00:00.000Z',
        url: 'https://forge.test/acme/widgets/-/merge_requests/13#note_n1',
      },
    })
    expect(result.comments[1]?.text).toBe(
      'reviewer 1: Keep changelog lines short.\n  author: Done, thanks',
    )
    expect(calls).toContain('compare acme/widgets early final-13')
    expect(calls.filter((call) => call.startsWith('compare'))).toHaveLength(1)
  })

  test('a failing discussions read is skipped, a forge without listing gives nothing', async () => {
    const lines: string[] = []
    const { forge } = fakeForge([mergeRequest(12)], { 12: new Error('boom') })
    const result = await collectReviewComments({
      forge,
      repo,
      since,
      maxMergeRequests: 50,
      discussionMergeRequests: 10,
      log: (line) => lines.push(line),
    })
    expect(result.comments).toEqual([])
    expect(lines).toEqual(['merge request !12: discussions not read (boom)'])
    const none = await collectReviewComments({
      forge: {},
      repo,
      since,
      maxMergeRequests: 50,
      discussionMergeRequests: 10,
    })
    expect(none.listed).toBe(false)
  })

  test('stays within the character cap', async () => {
    const long = 'x'.repeat(400)
    const { forge } = fakeForge([mergeRequest(12)], {
      12: Array.from({ length: 100 }, (_, index) =>
        thread(`d${index}`, [note(`n${index}`, 'dev-two', `${index} ${long}`)], { resolved: true }),
      ),
    })
    const result = await collectReviewComments({
      forge,
      repo,
      since,
      maxMergeRequests: 5,
      discussionMergeRequests: 5,
    })
    const total = result.comments.reduce((sum, comment) => sum + comment.text.length, 0)
    expect(total).toBeLessThanOrEqual(COMMENTS_CHARS)
    expect(result.comments.length).toBeLessThan(100)
  })
})
