import { expect, test } from 'bun:test'

import {
  commentBody,
  commentFinding,
  isSummaryNote,
  sizeAdviceBlock,
  sizeCallout,
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

test('sizeAdviceBlock gives the direction of the split and the note for AI agents', () => {
  const texts = adviceTexts('too-large', 150)
  const size = { minutes: 150, level: 'too-large' as const, files: 8, lines: 1300, groups: 3 }
  expect(sizeAdviceBlock(size)).toBe('')
  const block = sizeAdviceBlock(
    {
      ...size,
      advice: {
        texts,
        splittable: true,
        direction: 'Ship the widget model first, then the gadget screens.',
      },
    },
    'Review effort: 4/5.',
  )
  expect(block).toBe(
    `**${texts.estimate} ${texts.limit}** Review effort: 4/5. ${texts.split}\n\nShip the widget model first, then the gadget screens.\n\n_${texts.ai}_`,
  )

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

test('summaryNote gives the review time in the review language, for the whole merge request when incremental', () => {
  const data = {
    head: 'b'.repeat(40),
    previousHead: 'a'.repeat(40),
    mode: 'full' as const,
    verdict: 'looks-good' as const,
    summary: 'The gadget is fine.',
    size: { minutes: 130, level: 'ok' as const, files: 4, lines: 900, groups: 2 },
    comments: [],
    threads: [],
    skipped: [],
    stats: {
      files: 1,
      changedLines: 3,
      dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
    },
    checks: [],
  }
  expect(summaryNote({ ...data, effort: 2 })).toContain(
    '> ⏱️ **Estimated review time: ~2 h 10 min.** Review effort: 2/5.\n\nThe gadget is fine.\n\nReviewed `bbbbbbbb`: 1 file(s), 3 changed line(s).\n\n',
  )
  expect(summaryNote(data)).toStartWith(
    '### Holtkeeper review: Looks good\n\n> ⏱️ **Estimated review time: ~2 h 10 min.**\n\nThe gadget is fine.',
  )
  expect(summaryNote({ ...data, mode: 'incremental' })).toContain(
    '> ⏱️ **Estimated review time of the whole merge request: ~2 h 10 min.**',
  )
  const marked = summaryNote(
    { ...data, mode: 'incremental' },
    { locale: 'xx', t: (key, params) => `«${key}${params ? ` ${JSON.stringify(params)}` : ''}»` },
  )
  expect(marked).toContain(
    '«scope.timeWhole {"time":"«duration.hoursMinutes {\\"hours\\":2,\\"minutes\\":10}»"}»',
  )
})

test('sizeCallout quotes the advice to split under an emoji of its level', () => {
  const texts = adviceTexts('too-large', 150)
  const size = {
    minutes: 150,
    level: 'too-large' as const,
    files: 8,
    lines: 1300,
    groups: 3,
    advice: { texts, splittable: false, reason: 'A mechanical rename.' },
  }
  expect(sizeCallout(size, 'full')).toBe(
    `> 🛑 **${texts.estimate} ${texts.limit}**\n>\n> A mechanical rename.`,
  )
  expect(sizeCallout({ ...size, level: 'large' }, 'full')).toStartWith('> ⚠️ **')
  expect(sizeCallout(undefined, 'full')).toBe('')
  expect(sizeCallout({ ...size, minutes: 0 }, 'full')).toBe('')
})
