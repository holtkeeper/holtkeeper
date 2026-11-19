import { describe, expect, test } from 'bun:test'

import { checkAnswer, citationBacked, citationsIn } from './ask-citations.ts'

const evidence = [
  '### [rule:r1] Widget sizes\nKeep widget sizes in WidgetSize.',
  '# @acme/widgets@2.1.0\n### ShapeBase (class)\nSource: `src/shape.ts:14`',
  '## `gitlab:acme/shop` (team shop)\n- src/cart/Row.tsx:42 `<ShapeBase size="m" />`',
  'Issue: https://example.com/some-lib/issues/7 (closed, fixed in 1.2.0)',
]

const backed = (text: string) => {
  const [citation] = citationsIn(text)
  if (!citation) throw new Error('no citation')
  return citationBacked(citation, evidence.join('\n'))
}

describe('citationsIn', () => {
  test('finds bracketed citations of known kinds only', () => {
    expect(
      citationsIn('Use it [rule:r1] and [pkg:@acme/widgets@2.1.0 ShapeBase], see [note:x].').map(
        (citation) => [citation.kind, citation.value],
      ),
    ).toEqual([
      ['rule', 'r1'],
      ['pkg', '@acme/widgets@2.1.0 ShapeBase'],
    ])
  })
})

describe('citationBacked', () => {
  test('rules and learned rules need their id in the evidence', () => {
    expect(backed('[rule:r1]')).toBe(true)
    expect(backed('[rule:r2]')).toBe(false)
    expect(backed('[learn:r1]')).toBe(false)
  })

  test('a package needs its name, version and export', () => {
    expect(backed('[pkg:@acme/widgets@2.1.0]')).toBe(true)
    expect(backed('[pkg:@acme/widgets@2.1.0 ShapeBase]')).toBe(true)
    expect(backed('[pkg:@acme/widgets@3.0.0]')).toBe(false)
    expect(backed('[pkg:@acme/widgets@2.1.0 fooUtil]')).toBe(false)
  })

  test('a file needs its repository and path; the line may differ', () => {
    expect(backed('[file:gitlab:acme/shop src/cart/Row.tsx:42]')).toBe(true)
    expect(backed('[file:gitlab:acme/shop src/cart/Row.tsx:50]')).toBe(true)
    expect(backed('[file:gitlab:acme/shop src/cart/Other.tsx:1]')).toBe(false)
    expect(backed('[file:gitlab:acme/other src/cart/Row.tsx:42]')).toBe(false)
  })

  test('a url must appear verbatim', () => {
    expect(backed('[url:https://example.com/some-lib/issues/7]')).toBe(true)
    expect(backed('[url:https://example.com/some-lib/issues/8]')).toBe(false)
  })
})

describe('checkAnswer', () => {
  test('keeps backed citations and marks the others', () => {
    const checked = checkAnswer(
      'Sizes live in WidgetSize [rule:r1]. It was removed in 3.0 [pkg:@acme/widgets@3.0.0]. Again [rule:r1].',
      evidence,
    )
    expect(checked.text).toBe(
      'Sizes live in WidgetSize [rule:r1]. It was removed in 3.0 [unverified]. Again [rule:r1].',
    )
    expect(checked.verified.map((citation) => citation.text)).toEqual(['[rule:r1]'])
    expect(checked.dropped.map((citation) => citation.text)).toEqual(['[pkg:@acme/widgets@3.0.0]'])
  })

  test('the answer does not back itself', () => {
    expect(checkAnswer('Trust me [rule:zz].', []).verified).toEqual([])
  })
})
