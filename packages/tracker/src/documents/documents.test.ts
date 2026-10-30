import { expect, test } from 'bun:test'

import type { DocumentContent } from '../contracts.ts'
import { extractDocument } from './index.ts'

const page = (format: DocumentContent['format'], body: string): DocumentContent => ({
  ref: '1',
  title: 'T',
  version: 1,
  url: 'u',
  format,
  body,
})

test('table: key column, mapped columns and heading filter', () => {
  const body =
    '<h2>Flags</h2><table><tr><th>Flag</th><th>Description</th><th>Owner</th></tr><tr><td>a</td><td>A</td><td>me</td></tr><tr><td></td><td>empty</td><td></td></tr></table>' +
    '<h2>Other</h2><table><tr><th>Flag</th></tr><tr><td>z</td></tr></table>'
  expect(
    extractDocument(page('storage', body), {
      kind: 'table',
      keyColumn: 'flag',
      heading: 'flags',
      columns: { description: 'Description' },
    }),
  ).toEqual([{ key: 'a', attrs: { description: 'A' } }])
  expect(extractDocument(page('html', body), { kind: 'table', keyColumn: 'Flag' })).toEqual([
    { key: 'a', attrs: { description: 'A', owner: 'me' } },
    { key: 'z', attrs: {} },
  ])
  expect(
    extractDocument(page('markdown', '| Flag | Owner |\n|---|---|\n| `b` | team |\n'), {
      kind: 'table',
      keyColumn: 'Flag',
    }),
  ).toEqual([{ key: 'b', attrs: { owner: 'team' } }])
})

test('list: code spans, separators, patterns, headings', () => {
  const html =
    '<h2>Flags</h2><ul><li><code>new_hub</code> — the hub</li><li>turbo: faster animations</li><li>plain</li></ul><h2>Else</h2><ul><li>skip</li></ul>'
  expect(extractDocument(page('storage', html), { kind: 'list', heading: 'Flags' })).toEqual([
    { key: 'new_hub', attrs: { description: 'the hub' } },
    { key: 'turbo', attrs: { description: 'faster animations' } },
    { key: 'plain', attrs: {} },
  ])
  const markdown = '## Flags\n- `a` - first\n* [x] b: second\n1. c\n'
  expect(
    extractDocument(page('markdown', markdown), { kind: 'list' }).map((found) => found.key),
  ).toEqual(['a', 'b', 'c'])
  expect(
    extractDocument(page('markdown', '- flag a (on)\n- nothing\n'), {
      kind: 'list',
      pattern: '^flag (?<key>\\w+) \\((?<state>\\w+)\\)',
    }),
  ).toEqual([{ key: 'a', attrs: { state: 'on' } }])
})
