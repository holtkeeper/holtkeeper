import { expect, test } from 'bun:test'

import { commentBody, commentFinding, isSummaryNote, summaryNote } from './format.ts'

test('commentFinding reads back the category and id commentBody wrote', () => {
  const body = commentBody({
    id: 'f-12',
    severity: 'minor',
    category: 'style',
    title: 'Name the widget factory',
    body: 'Use a named function.',
    source: 'agent',
  })
  expect(commentFinding(body)).toEqual({ category: 'style', findingId: 'f-12' })
  expect(commentFinding('Plain reply without a marker.')).toBeUndefined()
  expect(commentFinding('Summary\n\n<!-- holtkeeper:review summary head=abc -->')).toBeUndefined()
})

test('isSummaryNote recognizes the summary note only', () => {
  const summary = summaryNote({
    head: 'a'.repeat(40),
    mode: 'full',
    verdict: 'looks-good',
    summary: 'The widget factory is fine.',
    comments: [],
    threads: [],
    skipped: [],
    stats: {
      files: 1,
      changedLines: 3,
      dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
    },
    checks: [],
  })
  expect(isSummaryNote(summary)).toBe(true)
  expect(isSummaryNote('### Holtkeeper review: Looks good\n\nCopied by hand.')).toBe(false)
  expect(isSummaryNote(`Quoting:\n\n${summary}`)).toBe(false)
})
