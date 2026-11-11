import { expect, test } from 'bun:test'

import { commentBody, commentFinding } from './format.ts'

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
