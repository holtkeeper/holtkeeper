import { expect, test } from 'bun:test'

import {
  commentBody,
  commentFinding,
  isSummaryNote,
  sizeAdviceBlock,
  summaryNote,
} from './format.ts'
import { adviceTexts } from './size.ts'

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

test('sizeAdviceBlock lists the parts with their files and the note for AI agents', () => {
  const texts = adviceTexts('too-large', 150)
  const size = { minutes: 150, level: 'too-large' as const, files: 8, lines: 1300, groups: 3 }
  expect(sizeAdviceBlock(size)).toBe('')
  const block = sizeAdviceBlock({
    ...size,
    advice: {
      texts,
      splittable: true,
      reason: 'Widgets and gadgets do not depend on each other.',
      parts: [
        { title: 'Widgets', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'] },
        { title: 'Gadgets', files: ['h.ts'] },
      ],
    },
  })
  expect(block).toContain(`**${texts.estimate} ${texts.limit}** ${texts.split}`)
  expect(block).toContain('1. **Widgets**: `a.ts`, `b.ts`, `c.ts`, `d.ts`, `e.ts` (+2)')
  expect(block).toContain('2. **Gadgets**: `h.ts`')
  expect(block).toContain('Widgets and gadgets do not depend on each other.')
  expect(block).toEndWith(`_${texts.ai}_`)

  const atomic = sizeAdviceBlock({
    ...size,
    advice: { texts, splittable: false, reason: 'A mechanical rename.' },
  })
  expect(atomic).toBe(`**${texts.estimate} ${texts.limit}**\n\nA mechanical rename.`)
})

test('summaryNote takes fixed texts from the messages and ends reviews with the feedback request', () => {
  const data = {
    head: 'a'.repeat(40),
    mode: 'full' as const,
    verdict: 'needs-changes' as const,
    summary: 'The widget shelf needs a guard.',
    comments: [],
    threads: [],
    skipped: [{ path: 'shelf.bin', reason: 'binary' as const }],
    stats: {
      files: 2,
      changedLines: 9,
      dropped: { belowSeverity: 1, overLimit: 0, duplicates: 0, invalid: 0 },
    },
    checks: [],
  }
  const english = summaryNote(data)
  expect(english).toContain('Holtkeeper learns from your answers')
  expect(english).toContain('| Severity | Findings |')
  const marked = summaryNote(data, {
    locale: 'xx',
    t: (key, params) => `«${key}${params ? ` ${JSON.stringify(params)}` : ''}»`,
  })
  expect(marked.startsWith('### Holtkeeper review: «verdict.needsChanges»')).toBe(true)
  expect(marked).toContain('| Severity | «findings.count» |')
  expect(marked).toContain('- `shelf.bin` — «notReviewed.binary»')
  expect(marked).toContain('«notReviewed.belowSeverity {"count":1}»')
  expect(marked).toContain('«summary.feedback»')
  expect(isSummaryNote(marked)).toBe(true)
  expect(summaryNote({ ...data, mode: 'skipped', verdict: 'skipped' })).not.toContain(
    'learns from your answers',
  )
})
