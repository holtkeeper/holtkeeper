import { describe, expect, test } from 'bun:test'

import { parseHtmlTables, parseMarkdownTables } from './html.ts'

describe('parseHtmlTables', () => {
  test('reads Confluence storage tables with headings, mentions, entities and colspan', () => {
    const html = [
      '<h2>Flags <em>live</em></h2>',
      '<table><tbody>',
      '<tr><th>Flag</th><th>Description</th><th>Owner</th></tr>',
      '<tr><td><p><code>new_lobby</code></p></td><td>A &amp; B&nbsp;&#8212; <br/>c</td><td><ac:link><ri:user ri:account-id="u-1"/></ac:link></td></tr>',
      '<tr><td colspan="2">wide</td><td><![CDATA[x < y]]></td></tr>',
      '</tbody></table>',
      '<h2>Other</h2><table><thead><tr><td>K</td></tr></thead><tbody><tr><td>v</td></tr></tbody></table>',
    ].join('')
    expect(parseHtmlTables(html)).toEqual([
      {
        heading: 'Flags live',
        headers: ['Flag', 'Description', 'Owner'],
        rows: [
          ['new_lobby', 'A & B — c', '@u-1'],
          ['wide', 'wide', 'x < y'],
        ],
      },
      { heading: 'Other', headers: ['K'], rows: [['v']] },
    ])
  })

  test('uses the first row as header without th cells and pads short rows', () => {
    expect(
      parseHtmlTables('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td></tr></table>'),
    ).toEqual([{ headers: ['a', 'b'], rows: [['1', '']] }])
  })

  test('survives malformed input', () => {
    expect(parseHtmlTables('<table><tr><td>a<td>b</table')).toEqual([
      { headers: ['a', 'b</table'], rows: [] },
    ])
    expect(parseHtmlTables('no tables < here')).toEqual([])
  })
})

test('parseMarkdownTables', () => {
  const markdown =
    '# Flags\n\n| Flag | Description |\n| --- | :-: |\n| `new_lobby` | **New** lobby \\| v2 |\n| [x](http://a) |\n\ntext\n'
  expect(parseMarkdownTables(markdown)).toEqual([
    {
      heading: 'Flags',
      headers: ['Flag', 'Description'],
      rows: [
        ['new_lobby', 'New lobby | v2'],
        ['x', ''],
      ],
    },
  ])
})
