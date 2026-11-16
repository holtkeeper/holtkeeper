import { describe, expect, test } from 'bun:test'

import type { DiffFile } from '@holtkeeper/forge'

import { changeDetail, diffExcerpt, testIdChanges, testIdsIn } from './detail.ts'

const attributes = ['data-testid', 'data-test', 'data-qa', 'testID']

const file = (path: string, diff: string, extra: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: path,
  newPath: path,
  status: 'modified',
  diff,
  ...extra,
})

describe('testIdsIn', () => {
  test('reads literal, bound and dynamic values in the common template syntaxes', () => {
    expect(
      testIdsIn(
        `<button data-testid="save" data-test-state={state} :data-qa="name" data-qa-x='one' testID={'native'} data-testid={\`row-\${id}\`} [attr.data-test]="value">`,
        attributes,
      ),
    ).toEqual([
      { attribute: 'data-testid', value: 'save' },
      { attribute: 'data-test-state', value: 'state', dynamic: true },
      { attribute: 'data-qa', value: 'name', dynamic: true },
      { attribute: 'data-qa-x', value: 'one' },
      { attribute: 'testID', value: 'native' },
      { attribute: 'data-testid', value: 'row-${id}', dynamic: true },
      { attribute: 'data-test', value: 'value', dynamic: true },
    ])
    expect(testIdsIn('<div my-data-testid="no" data-testidx="no">', attributes)).toEqual([])
  })
})

describe('testIdChanges', () => {
  test('reports added and removed values; moved ones are neither', () => {
    const diff = [
      '@@ -1,3 +1,3 @@',
      '-<button data-testid="old-save">',
      '+<button data-testid="save">',
      '-  <span data-qa="moved">',
      '+    <span data-qa="moved">',
      ' <div data-testid="kept">',
    ].join('\n')
    expect(testIdChanges('src/Panel.tsx', diff, attributes)).toEqual({
      file: 'src/Panel.tsx',
      added: [{ attribute: 'data-testid', value: 'save' }],
      removed: [{ attribute: 'data-testid', value: 'old-save' }],
    })
    expect(testIdChanges('a.ts', '+const x = 1', attributes)).toBeUndefined()
  })

  test('changeDetail counts lines per file and keeps test id changes', () => {
    const detail = changeDetail(
      [
        file('src/Panel.tsx', '@@\n+<a data-testid="open">\n-old\n+new'),
        file('logo.png', '', { binary: true, status: 'added' }),
        file('src/New.tsx', '@@\n+x', { oldPath: 'src/Old.tsx', status: 'renamed' }),
      ],
      attributes,
    )
    expect(detail.files).toEqual([
      { path: 'src/Panel.tsx', status: 'modified', additions: 2, deletions: 1 },
      { path: 'logo.png', status: 'added', additions: 0, deletions: 0, binary: true },
      {
        path: 'src/New.tsx',
        oldPath: 'src/Old.tsx',
        status: 'renamed',
        additions: 1,
        deletions: 0,
      },
    ])
    expect(detail.testIds).toHaveLength(1)
    expect(detail.partial).toBeUndefined()
  })
})

describe('diffExcerpt', () => {
  test('keeps source diffs within the budget and names the rest', () => {
    const excerpt = diffExcerpt(
      [
        file('src/a.ts', '+a'.repeat(10)),
        file('bun.lock', '+lock'),
        file('src/b.ts', '+b'.repeat(500)),
        file('src/c.ts', '+c'),
      ],
      { budget: 200, perFile: 50 },
    )
    expect(excerpt).toContain('--- modified src/a.ts')
    expect(excerpt).toContain('(cut)')
    expect(excerpt).toContain('--- modified src/c.ts')
    expect(excerpt).toContain('Not shown: bun.lock')
  })
})
