import { expect, test } from 'bun:test'

import { resolveImport } from './modules.ts'

const files = new Set(['src/a.ts', 'src/b.tsx', 'src/lib/index.ts', 'src/c.mts', 'src/plain.js'])

test.each([
  ['./a', 'src/a.ts'],
  ['./a.ts', 'src/a.ts'],
  ['./a.js', 'src/a.ts'],
  ['./b.js', 'src/b.tsx'],
  ['./b.jsx', 'src/b.tsx'],
  ['./c.mjs', 'src/c.mts'],
  ['./lib', 'src/lib/index.ts'],
  ['./lib/index.js', 'src/lib/index.ts'],
  ['./plain.js', 'src/plain.js'],
  ['../src/a', 'src/a.ts'],
  ['./missing', undefined],
  ['./style.css', undefined],
])('resolves %s from src/main.ts', (specifier, expected) => {
  expect(resolveImport(files, 'src/main.ts', specifier)).toBe(expected)
})
