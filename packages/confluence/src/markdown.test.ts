import { describe, expect, test } from 'bun:test'

import { markdownToStorage } from './markdown.ts'
import { isBalanced } from './xml.ts'

describe('markdownToStorage', () => {
  test('headings, paragraphs and inline formatting', () => {
    expect(
      markdownToStorage('# Title\n\nSome **bold**, *italic*, _also_ and `x < y` text.\nNext line.'),
    ).toBe(
      '<h1>Title</h1><p>Some <strong>bold</strong>, <em>italic</em>, <em>also</em> and <code>x &lt; y</code> text. Next line.</p>',
    )
  })

  test('escapes raw HTML and entities', () => {
    expect(markdownToStorage('<script>alert("x")</script> & co')).toBe(
      '<p>&lt;script&gt;alert("x")&lt;/script&gt; &amp; co</p>',
    )
  })

  test('links keep safe schemes only and escape attributes', () => {
    expect(
      markdownToStorage('[docs](https://example.com/a?b=1&c="2") and [bad](javascript:alert(1))'),
    ).toBe('<p><a href="https://example.com/a?b=1&amp;c=&quot;2&quot;">docs</a> and bad</p>')
    expect(markdownToStorage('<https://example.com>')).toBe(
      '<p><a href="https://example.com">https://example.com</a></p>',
    )
  })

  test('intraword underscores and escapes stay literal', () => {
    expect(markdownToStorage('snake_case_name and \\*not em\\*')).toBe(
      '<p>snake_case_name and *not em*</p>',
    )
  })

  test('nested lists', () => {
    expect(
      markdownToStorage('- one\n- two\n  - two.a\n  - two.b\n- three\n\n1. first\n2. second'),
    ).toBe(
      '<ul><li>one</li><li>two<ul><li>two.a</li><li>two.b</li></ul></li><li>three</li></ul><ol><li>first</li><li>second</li></ol>',
    )
  })

  test('tables with alignment and escaped pipes', () => {
    expect(markdownToStorage('| Name | Count |\n| :--- | ---: |\n| a \\| b | **2** |')).toBe(
      '<table><tbody><tr><th style="text-align: left;">Name</th><th style="text-align: right;">Count</th></tr>' +
        '<tr><td style="text-align: left;">a | b</td><td style="text-align: right;"><strong>2</strong></td></tr></tbody></table>',
    )
  })

  test('fenced code becomes the code macro with CDATA', () => {
    expect(markdownToStorage('```ts\nconst a = "<b>" && x]]>y\n```')).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>' +
        '<ac:plain-text-body><![CDATA[const a = "<b>" && x]]]]><![CDATA[>y]]></ac:plain-text-body></ac:structured-macro>',
    )
  })

  test('quotes, rules, strikethrough and hard breaks', () => {
    expect(markdownToStorage('> quoted\n\n---\n\n~~gone~~ line  \nbreak')).toBe(
      '<blockquote><p>quoted</p></blockquote><hr /><p><del>gone</del> line<br />break</p>',
    )
  })

  test('output is always balanced', () => {
    for (const input of [
      '**unclosed',
      '[x](',
      '- a\n\n  b\n- c',
      '| a |\n| - |\n| b | c | d |',
      '```\nopen',
    ])
      expect(isBalanced(markdownToStorage(input))).toBe(true)
  })
})
