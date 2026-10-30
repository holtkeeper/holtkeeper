import { expect, test } from 'bun:test'

import { encode } from '@jridgewell/sourcemap-codec'

import { attributeSourceMap } from './sourcemap.ts'

test('attributes each generated span to the source of its segment', () => {
  const code = 'var a=1;var bb=2;\n/*x*/var c="é";'
  const map = {
    sources: ['lib.js', 'app.ts'],
    sourceRoot: 'src',
    mappings: encode([
      [
        [0, 0, 0, 0],
        [8, 1, 0, 0],
      ],
      [[5, 1, 1, 0], [13]],
    ]),
  }
  const result = attributeSourceMap(code, map)
  expect(result.bySource.get('src/lib.js')).toBe(8)
  // `var bb=2;` (9) plus `var c="é` where é is two UTF-8 bytes (9).
  expect(result.bySource.get('src/app.ts')).toBe(9 + 9)
  // newline, `/*x*/`, and `";` after the source-less segment.
  expect(result.unmapped).toBe(1 + 5 + 2)
  const total = [...result.bySource.values()].reduce((sum, bytes) => sum + bytes, result.unmapped)
  expect(total).toBe(new TextEncoder().encode(code).length)
})

test('counts code without mappings as unmapped', () => {
  const result = attributeSourceMap('abc\ndef', { sources: [], mappings: '' })
  expect(result.bySource.size).toBe(0)
  expect(result.unmapped).toBe(7)
})
