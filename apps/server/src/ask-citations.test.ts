import { describe, expect, test } from 'bun:test'

import { checkAnswer, citationBacked, citationsIn } from './ask-citations.ts'

const evidence = [
  '### [rule:r1] Widget sizes\nKeep widget sizes in WidgetSize.',
  '# @acme/widgets@2.1.0\n### ShapeBase (class)\nSource: `src/shape.ts:14`',
  '## `gitlab:acme/shop` (team shop)\n- src/cart/Row.tsx:42 `<ShapeBase size="m" />`',
  '### #7 Crash on start\nIssue: https://example.com/some-lib/issues/7 (closed, fixed in 1.2.0)',
]

const backed = (text: string) => {
  const [citation] = citationsIn(text)
  if (!citation) throw new Error('no citation')
  return citationBacked(citation, evidence)
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

const over = (text: string, items: string[]) => {
  const [citation] = citationsIn(text)
  if (!citation) throw new Error('no citation')
  return citationBacked(citation, items)
}

describe('citationBacked against near misses', () => {
  test('ids, versions and urls count only as whole tokens', () => {
    expect(over('[rule:r1]', ['### [rule:r12] Other\nBody.'])).toBe(false)
    expect(over('[pkg:some-lib@3.0.0]', ['# some-lib\n- 13.0.0 (latest)'])).toBe(false)
    expect(over('[url:https://example.com/a]', ['Issue\nsee https://example.com/a/b'])).toBe(false)
    expect(over('[url:https://example.com/a]', ['Issue\nFixed, see https://example.com/a.'])).toBe(
      true,
    )
  })

  test('a version has to stand with its package', () => {
    const list = ['- some-lib 1.2.0\n- other-lib 3.0.0']
    expect(over('[pkg:some-lib@1.2.0]', list)).toBe(true)
    expect(over('[pkg:some-lib@3.0.0]', list)).toBe(false)
    expect(over('[pkg:some-lib@1.4.0]', ['# some-lib (npm, third-party)\n- 1.4.0 (used)'])).toBe(
      true,
    )
  })

  test('a one-line result is a message and backs nothing', () => {
    expect(
      over('[pkg:some-lib@9.9.9 fooUtil]', [
        'No package or export matches "some-lib@9.9.9 fooUtil".',
      ]),
    ).toBe(false)
    expect(
      over('[doc:some-lib@1.4.0 docs/guide.md]', [
        'some-lib@1.4.0 has no document docs/guide.md. Call without path for the list.',
      ]),
    ).toBe(false)
  })

  test('rules and issues whose text says "is not" still back their citations', () => {
    expect(
      over('[rule:r7]', ['### [rule:r7] Default export is not allowed\nUse named exports.']),
    ).toBe(true)
    expect(
      over('[url:https://example.com/some-lib/issues/12]', [
        '### #12 [closed] TypeError: fooUtil is not a function — https://example.com/some-lib/issues/12\nFixed in 2.1.1.',
      ]),
    ).toBe(true)
  })

  test('a version in a section heading stands with the package its section names', () => {
    const sites = [
      "## `gitlab:acme/shop` (2.1.0)\n\n**fooUtil** `src/a.ts:12` — call\n```tsx\nimport { fooUtil } from 'some-lib'\n```",
    ]
    expect(over('[pkg:some-lib@2.1.0 fooUtil]', sites)).toBe(true)
    expect(over('[pkg:other-lib@2.1.0]', sites)).toBe(false)
    expect(
      over('[pkg:some-lib@1.4.0]', ['# some-lib (npm)\n## Advisories\n### Seen at\n- 1.4.0']),
    ).toBe(true)
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
