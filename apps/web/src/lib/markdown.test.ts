import { describe, expect, test } from 'bun:test'

import { parseInline, parseMarkdown } from './markdown.ts'

describe('parseInline', () => {
  test('code, emphasis and safe links', () => {
    expect(parseInline('a `b` **c** _d_ [e](https://x.dev)')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'd' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'https://x.dev', children: [{ kind: 'text', text: 'e' }] },
    ])
  })

  test('drops unsafe link targets and keeps html as text', () => {
    expect(parseInline('[x](javascript:alert(1))')[0]).toEqual({
      kind: 'text',
      text: '[x](javascript:alert(1)',
    })
    expect(parseInline('<img onerror=x>')).toEqual([{ kind: 'text', text: '<img onerror=x>' }])
  })
})

describe('parseMarkdown', () => {
  test('blocks', () => {
    const blocks = parseMarkdown(
      '# Title\n\nline one\nline two\n\n- a\n- b\n1. c\n\n```\ncode <b>\n```\n> quote\n---',
    )
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'quote',
      'rule',
    ])
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'line one line two' }],
    })
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: 'a' }], [{ text: 'b' }]] })
    expect(blocks[4]).toEqual({ kind: 'code', text: 'code <b>' })
  })
})
