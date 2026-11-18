import { expect, test } from 'bun:test'

import type { ReviewRow } from '@holtkeeper/api'

import {
  acceptanceTone,
  filterReviews,
  mergeRequestNumber,
  outcomeSegments,
  outcomeSince,
  parseReviewsSearch,
  reviewAuthors,
  reviewJobInput,
  reviewSince,
  reviewTotals,
  severitySegments,
  shareText,
  severityText,
  sortReviews,
  tokenText,
} from './reviews.ts'

const row = (patch: Partial<ReviewRow> & { iid: number }): ReviewRow => {
  const { iid, ...rest } = patch
  return {
    analysisId: `a${iid}`,
    repo: { forge: 'acme', path: 'acme/widget-kit' },
    createdAt: `2026-11-0${iid}T10:00:00.000Z`,
    mergeRequest: { iid, title: `Widget change ${iid}`, url: `https://x.test/mr/${iid}` },
    mode: 'full',
    verdict: 'looks-good',
    findings: 0,
    severities: { critical: 0, major: 0, minor: 0, info: 0 },
    resolved: 0,
    ruleSources: [],
    ...rest,
  }
}

test('Reviews search keeps known values and drops the rest', () => {
  expect(
    parseReviewsSearch({
      repo: 'acme:acme/widgets',
      q: 'cart',
      verdict: 'needs-changes',
      mode: 'incremental',
      author: 'Teo R.',
      days: '7',
      review: 'a1',
      tab: 'summary',
      extra: 'x',
    }),
  ).toEqual({
    repo: 'acme:acme/widgets',
    q: 'cart',
    verdict: 'needs-changes',
    mode: 'incremental',
    author: 'Teo R.',
    days: 7,
    review: 'a1',
    tab: 'summary',
  })
  expect(parseReviewsSearch({ repo: '', verdict: 'great', days: 12, tab: 'cost' })).toEqual({})
  expect(parseReviewsSearch({ days: 90 })).toEqual({ days: 90 })
})

test('filters by text, mode and author on the client', () => {
  const rows = [
    row({
      iid: 1,
      mergeRequest: { iid: 12, title: 'Add Widget cache', url: 'u', author: 'Ana S.' },
    }),
    row({ iid: 2, mode: 'incremental', repo: { forge: 'acme', path: 'acme/ledger-api' } }),
    row({ iid: 3, mergeRequest: { iid: 7, title: 'Rename fooUtil', url: 'u', author: 'Jun P.' } }),
  ]
  expect(filterReviews(rows, { q: 'widget CACHE' }).map((r) => r.analysisId)).toEqual(['a1'])
  expect(filterReviews(rows, { q: '!12' }).map((r) => r.analysisId)).toEqual(['a1'])
  expect(filterReviews(rows, { q: 'ledger' }).map((r) => r.analysisId)).toEqual(['a2'])
  expect(filterReviews(rows, { mode: 'incremental' }).map((r) => r.analysisId)).toEqual(['a2'])
  expect(filterReviews(rows, { author: 'Jun P.' }).map((r) => r.analysisId)).toEqual(['a3'])
  expect(filterReviews(rows, {})).toHaveLength(3)
  expect(reviewAuthors(rows)).toEqual(['Ana S.', 'Jun P.'])
})

test('totals sum verdicts, severities, resolved threads and cost', () => {
  const totals = reviewTotals([
    row({
      iid: 1,
      verdict: 'needs-changes',
      findings: 3,
      severities: { critical: 1, major: 2, minor: 0, info: 0 },
      resolved: 1,
      costUsd: 0.25,
    }),
    row({ iid: 2, findings: 1, severities: { critical: 0, major: 0, minor: 1, info: 0 } }),
    row({ iid: 3, verdict: 'skipped', costUsd: 0.05 }),
  ])
  expect(totals).toEqual({
    reviews: 3,
    verdicts: { 'looks-good': 1, 'needs-changes': 1, skipped: 1 },
    findings: 4,
    severities: { critical: 1, major: 2, minor: 1, info: 0 },
    resolved: 1,
    costUsd: 0.3,
  })
  expect(severityText(totals.severities)).toBe('1 critical · 2 major · 1 minor')
  expect(severityText({ critical: 0, major: 0, minor: 0, info: 0 })).toBe('')
  expect(severitySegments(totals.severities).map((s) => [s.label, s.value, s.tone])).toEqual([
    ['critical', 1, 'danger'],
    ['major', 2, 'warning'],
    ['minor', 1, 'info'],
    ['info', 0, 'default'],
  ])
})

const ids = (sorted: ReviewRow[]) => sorted.map((r) => r.analysisId)

test('sorts by findings and cost, keeping rows without cost last', () => {
  const rows = [
    row({ iid: 1, findings: 2, costUsd: 0.1 }),
    row({ iid: 2, findings: 5 }),
    row({ iid: 3, findings: 1, costUsd: 0.4 }),
  ]
  expect(ids(sortReviews(rows, { key: 'findings', direction: 'desc' }))).toEqual(['a2', 'a1', 'a3'])
  expect(ids(sortReviews(rows, { key: 'cost', direction: 'desc' }))).toEqual(['a3', 'a1', 'a2'])
  expect(ids(sortReviews(rows, { key: 'when', direction: 'asc' }))).toEqual(['a1', 'a2', 'a3'])
  expect(ids(sortReviews(rows, null))).toEqual(['a1', 'a2', 'a3'])
})

test('since leaves the server default for 30 days', () => {
  const now = new Date('2026-11-12T00:00:00.000Z')
  expect(reviewSince(undefined, now)).toBeUndefined()
  expect(reviewSince(30, now)).toBeUndefined()
  expect(reviewSince(7, now)).toBe('2026-11-05T00:00:00.000Z')
})

test('reads a merge request number from text or a URL', () => {
  expect(mergeRequestNumber('42')).toBe(42)
  expect(mergeRequestNumber(' !42 ')).toBe(42)
  expect(mergeRequestNumber('#7')).toBe(7)
  expect(mergeRequestNumber('https://gitlab.acme.dev/acme/widget-kit/-/merge_requests/118')).toBe(
    118,
  )
  expect(mergeRequestNumber('https://github.com/acme/widget-kit/pull/9/files')).toBe(9)
  expect(mergeRequestNumber('0')).toBeUndefined()
  expect(mergeRequestNumber('abc')).toBeUndefined()
  expect(mergeRequestNumber('')).toBeUndefined()
})

test('the review job names the merge request and forces only when asked', () => {
  const repo = { forge: 'acme', path: 'acme/widget-kit' }
  expect(reviewJobInput(repo, 12)).toEqual({
    analyzer: 'review',
    repo: 'acme:acme/widget-kit',
    options: { mergeRequest: 12 },
  })
  expect(reviewJobInput(repo, 12, true).options).toEqual({ mergeRequest: 12, force: true })
})

test('token usage reads compactly', () => {
  expect(tokenText({ inputTokens: 96_400, outputTokens: 812, turns: 3 })).toBe(
    '96k in · 812 out · 3 turns',
  )
  expect(tokenText({ inputTokens: 2_350_000, turns: 1 })).toBe('2.4M in · 1 turn')
  expect(tokenText({ turns: 0 })).toBe('')
})

test('Reviews search keeps the outcomes card settings and drops unknown ones', () => {
  expect(parseReviewsSearch({ by: 'promptVersion', outcomes: '180' })).toEqual({
    by: 'promptVersion',
    outcomes: 180,
  })
  expect(parseReviewsSearch({ by: 'color', outcomes: 7 })).toEqual({})
})

test('the outcomes period starts at midnight so the query stays the same all day', () => {
  const morning = new Date('2026-11-15T01:00:00.000Z')
  const evening = new Date('2026-11-15T23:30:00.000Z')
  expect(outcomeSince(90, morning)).toBe('2026-08-17T00:00:00.000Z')
  expect(outcomeSince(90, evening)).toBe(outcomeSince(90, morning))
  expect(outcomeSince(30, morning)).toBe('2026-10-16T00:00:00.000Z')
})

test('outcome bars list fixed first and shares read as whole percents', () => {
  const segments = outcomeSegments({
    key: 'bug',
    comments: 10,
    fixed: 5,
    resolved: 2,
    ignored: 2,
    unknown: 1,
    up: 0,
    down: 0,
  })
  expect(segments.map((segment) => [segment.label, segment.value])).toEqual([
    ['fixed', 5],
    ['resolved', 2],
    ['ignored', 2],
    ['unknown', 1],
  ])
  expect(shareText(0.4166)).toBe('42%')
  expect(shareText(undefined)).toBe('—')
  expect(acceptanceTone(0.7)).toBe('success')
  expect(acceptanceTone(0.5)).toBe('warning')
  expect(acceptanceTone(0.1)).toBe('danger')
  expect(acceptanceTone(undefined)).toBe('default')
})
