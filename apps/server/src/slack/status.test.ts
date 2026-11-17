import { expect, test } from 'bun:test'

import type { Discussion } from '@holtkeeper/forge'
import { type ReviewData, commentBody, summaryNote } from '@holtkeeper/review'

import { fallbackSlackEmoji } from './connection.ts'
import { mergeRequestStatusOf, reviewStatusOf, statusListText, worstStatus } from './status.ts'

const finding = (severity: 'info' | 'minor' | 'major' | 'critical', posted = true) => ({
  id: `f-${severity}`,
  path: 'src/widget.ts',
  line: 3,
  severity,
  category: 'bug' as const,
  title: 'Off by one',
  body: 'The loop skips the last item.',
  source: 'agent' as const,
  posted,
})

const review = (overrides: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: 7,
    title: 'Add widget',
    webUrl: 'https://git.acme.test/shapes/widget/-/merge_requests/7',
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    author: 'alex',
  },
  head: 'b'.repeat(40),
  mode: 'full',
  verdict: 'looks-good',
  summary: 'Fine.',
  comments: [],
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 4,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  ...overrides,
})

test('a finished review maps to clean, minor, changes or skipped', () => {
  expect(reviewStatusOf(review())).toBe('clean')
  expect(reviewStatusOf(review({ comments: [finding('minor'), finding('info')] }))).toBe('minor')
  expect(reviewStatusOf(review({ comments: [finding('major', false)] }))).toBe('clean')
  expect(reviewStatusOf(review({ comments: [finding('critical')] }))).toBe('changes')
  expect(reviewStatusOf(review({ verdict: 'needs-changes' }))).toBe('changes')
  expect(reviewStatusOf(review({ mode: 'skipped', verdict: 'skipped' }))).toBe('skipped')
})

const thread = (
  body: string,
  options: { resolved?: boolean; resolvable?: boolean } = {},
): Discussion => ({
  id: `d-${body.length}-${options.resolved ? 'r' : 'o'}`,
  resolvable: options.resolvable ?? true,
  resolved: options.resolved ?? false,
  notes: [
    { id: 1, author: 'holtkeeper', body: 'changed the description', createdAt: '', system: true },
    { id: 2, author: 'holtkeeper', body, createdAt: '', system: false },
  ],
})

const findingThread = (
  severity: 'info' | 'minor' | 'major' | 'critical',
  options: { resolved?: boolean } = {},
) => thread(commentBody({ ...finding(severity), id: `f-${severity}-thread` }), options)

test('open Holtkeeper finding threads decide the status, whatever the verdict', () => {
  const serious = review({ verdict: 'needs-changes', comments: [finding('major')] })
  expect(mergeRequestStatusOf(serious, [findingThread('major')])).toBe('changes')
  expect(mergeRequestStatusOf(serious, [findingThread('major', { resolved: true })])).toBe('clean')
  expect(
    mergeRequestStatusOf(serious, [
      findingThread('critical', { resolved: true }),
      findingThread('info'),
    ]),
  ).toBe('minor')
  // Threads of earlier runs count too: an incremental run that found nothing new is not clean.
  expect(mergeRequestStatusOf(review({ mode: 'incremental' }), [findingThread('critical')])).toBe(
    'changes',
  )
})

test('other threads, the summary and unresolvable notes do not count', () => {
  const summary = summaryNote(review({ verdict: 'needs-changes' }))
  expect(
    mergeRequestStatusOf(review({ verdict: 'needs-changes' }), [
      thread(summary),
      thread('Please rename the gizmo.'),
      thread(commentBody({ ...finding('major'), id: 'f-note' }), { resolvable: false }),
    ]),
  ).toBe('clean')
})

test('a skipped run stays skipped and without threads the run alone decides', () => {
  const skipped = review({ mode: 'skipped', verdict: 'skipped' })
  expect(mergeRequestStatusOf(skipped, [findingThread('major')])).toBe('skipped')
  expect(mergeRequestStatusOf(review({ comments: [finding('minor')] }), undefined)).toBe('minor')
})

test('a message about several merge requests shows the worst status', () => {
  expect(worstStatus([])).toBeUndefined()
  expect(worstStatus(['clean', undefined, 'skipped'])).toBe('skipped')
  expect(worstStatus(['clean', 'minor', 'reviewing'])).toBe('reviewing')
  expect(worstStatus(['reviewing', 'changes', 'clean'])).toBe('changes')
})

test('the status list has one line per merge request with emoji, English name and link', () => {
  const url = 'https://git.acme.test/shapes/widget/-/merge_requests/'
  expect(
    statusListText(
      [
        { status: 'changes', url: `${url}7`, label: 'widget!7 Fix <gizmo> & | sprocket' },
        { status: 'minor', url: `${url}8`, label: 'widget!8 Add shape' },
        { url: `${url}9`, label: 'widget!9' },
        { status: 'reviewing', url: `${url}10`, label: 'widget!10 Tidy' },
      ],
      { ...fallbackSlackEmoji, reviewing: 'thumbsup::skin-tone-2' },
    ),
  ).toBe(
    [
      `:red_circle: Needs changes — <${url}7|widget!7 Fix &lt;gizmo&gt; &amp; ¦ sprocket>`,
      `:large_orange_circle: Minor findings — <${url}8|widget!8 Add shape>`,
      `Not reviewed — <${url}9|widget!9>`,
      `:thumbsup::skin-tone-2: Reviewing — <${url}10|widget!10 Tidy>`,
    ].join('\n'),
  )
})
