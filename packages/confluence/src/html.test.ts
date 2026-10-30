import { describe, expect, test } from 'bun:test'

import { sanitizeHtml } from './html.ts'

describe('sanitizeHtml', () => {
  test('keeps the storage subset and renames legacy tags', () => {
    expect(sanitizeHtml('<h2 class="x">T</h2><p>a <b>b</b> <i>c</i><br>d</p><hr>')).toBe(
      '<h2>T</h2><p>a <strong>b</strong> <em>c</em><br />d</p><hr />',
    )
  })

  test('drops scripts with content, unwraps unknown tags and strips attributes', () => {
    expect(
      sanitizeHtml(
        '<div onclick="x()"><script>alert(1)</script><span style="c">t</span><style>p{}</style></div>',
      ),
    ).toBe('t')
  })

  test('links keep only safe href', () => {
    expect(
      sanitizeHtml(
        '<a href="javascript:alert(1)">x</a><a href="https://e.com/?a=1&amp;b=2" target="_blank">y</a>',
      ),
    ).toBe('<a>x</a><a href="https://e.com/?a=1&amp;b=2">y</a>')
  })

  test('closes implied and unclosed elements', () => {
    expect(
      sanitizeHtml('<ul><li>a<li>b</ul><p>x<p>y<table><tr><td colspan="2" width="9">1<td>2'),
    ).toBe(
      '<ul><li>a</li><li>b</li></ul><p>x</p><p>y</p><table><tr><td colspan="2">1</td><td>2</td></tr></table>',
    )
  })

  test('re-escapes text and ignores stray closing tags', () => {
    expect(sanitizeHtml('a &lt; b &amp; c > d</p><!-- note -->&copy;')).toBe(
      'a &lt; b &amp; c &gt; d&amp;copy;',
    )
  })
})

test('obfuscated javascript links are dropped', () => {
  expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a><a href=" JAVASCRIPT:x">y</a>')).toBe(
    '<a>x</a><a>y</a>',
  )
})
