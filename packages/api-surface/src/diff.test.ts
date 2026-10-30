import { expect, test } from 'bun:test'

import { diffApi, diffPackage, normalizeSignature, versionBump } from './diff.ts'
import type { ApiPackage, ApiSymbol } from './model.ts'

const symbol = (name: string, signature: string, extra: Partial<ApiSymbol> = {}): ApiSymbol => ({
  name,
  kind: 'function',
  signature,
  file: 'src/index.ts',
  line: 1,
  ...extra,
})

const pkg = (version: string, symbols: ApiSymbol[]): ApiPackage => ({
  name: '@acme/ui',
  version,
  private: false,
  dir: '.',
  entries: [{ subpath: '.', symbols }],
})

test('versionBump treats a 0.x minor as breaking', () => {
  expect(versionBump('1.2.3', '2.0.0')).toBe('major')
  expect(versionBump('1.2.3', '1.3.0')).toBe('minor')
  expect(versionBump('1.2.3', '1.2.4')).toBe('patch')
  expect(versionBump('0.2.3', '0.3.0')).toBe('major')
  expect(versionBump('1.2.3', '1.2.3')).toBe('none')
  expect(versionBump('1.2.3', 'next')).toBeUndefined()
})

test('normalizeSignature ignores comments and layout', () => {
  expect(normalizeSignature('interface A {\n  /** doc */\n  a: string // note\n}')).toBe(
    normalizeSignature('interface A { a: string }'),
  )
  expect(normalizeSignature("const url = 'https://x'")).toBe("const url = 'https://x'")
})

test('diffPackage classifies changes and warns about removals without a major bump', () => {
  const before = pkg('1.2.0', [
    symbol('keep', 'function keep(): void'),
    symbol('gone', 'function gone(): void'),
    symbol('edit', 'function edit(a: string): void'),
    symbol('old', 'function old(): void'),
  ])
  const after = pkg('1.3.0', [
    symbol('keep', 'function keep():   void /** same */'),
    symbol('edit', 'function edit(a: string, b?: number): void'),
    symbol('old', 'function old(): void', { deprecated: 'use keep' }),
    symbol('fresh', 'function fresh(): void'),
  ])
  const diff = diffPackage(before, after)
  expect(diff.changes.map((change) => [change.change, change.name])).toEqual([
    ['removed', 'gone'],
    ['changed', 'edit'],
    ['deprecated', 'old'],
    ['added', 'fresh'],
  ])
  expect(diff).toMatchObject({
    from: '1.2.0',
    to: '1.3.0',
    added: 1,
    removed: 1,
    changed: 1,
    deprecated: 1,
    required: 'major',
    bumped: 'minor',
    semverWarning: '1 export removed, but 1.2.0 → 1.3.0 is not a major bump',
  })
  expect(diffPackage(before, { ...after, version: '2.0.0' }).semverWarning).toBeUndefined()
})

test('diffApi leaves out unchanged packages and covers added ones', () => {
  const same = pkg('1.0.0', [symbol('a', 'function a(): void')])
  const other = { ...same, name: 'other' }
  expect(diffApi([same], [same])).toEqual([])
  const [added] = diffApi([same], [same, other])
  expect(added).toMatchObject({ name: 'other', added: 1, required: 'minor' })
  expect(added?.from).toBeUndefined()
})
