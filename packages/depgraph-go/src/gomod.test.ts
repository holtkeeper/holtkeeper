import { expect, test } from 'bun:test'

import { parseGoMod, parseGoWork } from './gomod.ts'

test('parses module and require directives in both forms', () => {
  expect(
    parseGoMod(
      'module "example.com/x" // comment\n\ngo 1.22\n\nrequire a.com/b v1.0.0\nrequire (\n\tc.com/d v0.2.0 // indirect\n\n\te.com/f v1.2.3-0.20240101000000-abcdef123456\n)\n',
    ),
  ).toEqual({
    module: 'example.com/x',
    require: [
      { path: 'a.com/b', version: 'v1.0.0' },
      { path: 'c.com/d', version: 'v0.2.0' },
      { path: 'e.com/f', version: 'v1.2.3-0.20240101000000-abcdef123456' },
    ],
  })
})

test('parses use directives of go.work', () => {
  expect(parseGoWork('go 1.22\n\nuse ./tools\nuse (\n\t.\n\t./svc/api/ // api\n)\n')).toEqual([
    'tools',
    '.',
    'svc/api/',
  ])
})
