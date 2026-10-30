import { describe, expect, test } from 'bun:test'

import type { DiffFile } from '@holtkeeper/forge'

import { addedFile } from '../test/fakes.ts'
import { DEFAULT_IGNORE, matchesAny, scopeDiff } from './scope.ts'

const file = (path: string, diff: string, extra: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: path,
  newPath: path,
  status: 'modified',
  diff,
  ...extra,
})

describe('matchesAny', () => {
  test('default globs match at the root and nested', () => {
    expect(matchesAny('bun.lock', DEFAULT_IGNORE)).toBe(true)
    expect(matchesAny('apps/web/pnpm-lock.yaml', DEFAULT_IGNORE)).toBe(true)
    expect(matchesAny('src/__snapshots__/a.test.ts.snap', DEFAULT_IGNORE)).toBe(true)
    expect(matchesAny('dist/index.js', DEFAULT_IGNORE)).toBe(true)
    expect(matchesAny('src/index.ts', DEFAULT_IGNORE)).toBe(false)
  })

  test('slashless globs match base names', () => {
    expect(matchesAny('deep/dir/schema.graphql', ['*.graphql'])).toBe(true)
  })
})

describe('scopeDiff', () => {
  const files = [
    file('src/a.ts', addedFile(['a', 'b', 'c'])),
    file('bun.lock', addedFile(['x'])),
    file('logo.png', '', { binary: true }),
    file('huge.ts', '', { collapsed: true }),
    file('old.ts', '@@ -1 +0,0 @@\n-gone\n', { status: 'deleted' }),
    file('only-removed.ts', '@@ -1,2 +1,1 @@\n a\n-b\n'),
  ]

  test('keeps added lines of reviewable files and explains the rest', () => {
    const scope = scopeDiff(files, { ignore: DEFAULT_IGNORE })
    expect(scope.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect([...(scope.files[0]?.lines ?? [])]).toEqual([1, 2, 3])
    expect(scope.changedLines).toBe(3)
    expect(scope.skipped).toEqual([
      { path: 'bun.lock', reason: 'ignored' },
      { path: 'logo.png', reason: 'binary' },
      { path: 'huge.ts', reason: 'collapsed' },
      { path: 'old.ts', reason: 'deleted' },
      { path: 'only-removed.ts', reason: 'unchanged' },
    ])
  })

  test('incremental scope is the intersection with the newer commits', () => {
    const mr = [file('src/a.ts', addedFile(['a', 'b', 'c'])), file('src/b.ts', addedFile(['x']))]
    const since = [file('src/a.ts', '@@ -1,2 +1,3 @@\n a\n+b\n c\n')]
    const scope = scopeDiff(mr, { ignore: [], since })
    expect(scope.files.map((f) => [f.path, [...f.lines]])).toEqual([['src/a.ts', [2]]])
    expect(scope.files[0]?.visible.size).toBe(3)
    expect(scope.skipped).toEqual([{ path: 'src/b.ts', reason: 'unchanged' }])
    expect(scope.changedLines).toBe(1)
  })
})
