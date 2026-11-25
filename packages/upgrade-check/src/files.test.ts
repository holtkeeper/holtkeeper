import { describe, expect, test } from 'bun:test'

import {
  type ChangedFile,
  MAX_AREAS,
  areaKeyOf,
  groupAreas,
  parseChangedFiles,
  parseUnifiedDiff,
  selectFiles,
} from './files.ts'

const changed = (path: string, lines = 10, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: path,
  status: 'modified',
  added: lines,
  deleted: 0,
  binary: false,
  ...extra,
})

describe('parseChangedFiles', () => {
  test('reads statuses, renames, counts and binary files', () => {
    const nameStatus = [
      'M',
      'src/widget.ts',
      'A',
      'src/gadget.ts',
      'D',
      'src/old.ts',
      'R087',
      'src/a.ts',
      'src/b.ts',
      'M',
      'assets/logo.png',
      '',
    ].join('\0')
    const numstat = [
      '3\t1\tsrc/widget.ts',
      '10\t0\tsrc/gadget.ts',
      '0\t7\tsrc/old.ts',
      '2\t2\t',
      'src/a.ts',
      'src/b.ts',
      '-\t-\tassets/logo.png',
      '',
    ].join('\0')
    expect(parseChangedFiles(nameStatus, numstat)).toEqual([
      changed('src/widget.ts', 3, { deleted: 1 }),
      changed('src/gadget.ts', 10, { status: 'added' }),
      changed('src/old.ts', 0, { status: 'deleted', deleted: 7 }),
      {
        path: 'src/b.ts',
        oldPath: 'src/a.ts',
        status: 'renamed',
        added: 2,
        deleted: 2,
        binary: false,
      },
      changed('assets/logo.png', 0, { binary: true }),
    ])
  })
})

describe('parseUnifiedDiff', () => {
  test('splits sections and keeps the diff from the first hunk', () => {
    const text = [
      'diff --git a/src/widget.ts b/src/widget.ts',
      'index 111..222 100644',
      '--- a/src/widget.ts',
      '+++ b/src/widget.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/src/a.ts b/src/b.ts',
      'similarity index 100%',
      'rename from src/a.ts',
      'rename to src/b.ts',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n')
    expect(parseUnifiedDiff(text)).toEqual([
      {
        oldPath: 'src/widget.ts',
        newPath: 'src/widget.ts',
        status: 'modified',
        diff: '@@ -1 +1 @@\n-old\n+new\n',
      },
      {
        oldPath: 'src/gone.ts',
        newPath: 'src/gone.ts',
        status: 'deleted',
        diff: '@@ -1 +0,0 @@\n-bye\n',
      },
      { oldPath: 'src/a.ts', newPath: 'src/b.ts', status: 'renamed', diff: '' },
      { oldPath: 'logo.png', newPath: 'logo.png', status: 'modified', diff: '', binary: true },
    ])
  })
})

describe('selectFiles', () => {
  test('skips lockfiles, generated and binary files', () => {
    const result = selectFiles([
      changed('src/widget.ts'),
      changed('bun.lock'),
      changed('web/dist/app.js'),
      changed('logo.png', 0, { binary: true }),
    ])
    expect(result.files.map((file) => file.path)).toEqual(['src/widget.ts'])
    expect(result.skipped).toEqual([
      { files: 2, reason: 'lockfiles, generated or vendored files' },
      { files: 1, reason: 'binary files' },
    ])
    expect(result.capped).toBe(false)
  })

  test('caps the file count, keeping source and small changes first', () => {
    const result = selectFiles(
      [changed('docs/guide.md', 1), changed('src/big.ts', 500), changed('src/small.ts', 2)],
      2,
    )
    expect(result.files.map((file) => file.path)).toEqual(['src/big.ts', 'src/small.ts'])
    expect(result.skipped).toEqual([{ files: 1, reason: 'past the limit of 2 files' }])
    expect(result.capped).toBe(true)
  })
})

describe('areaKeyOf', () => {
  test('groups by top-level directory, two levels under containers', () => {
    expect(areaKeyOf('README.md')).toBe('(root)')
    expect(areaKeyOf('web/src/app.ts')).toBe('web')
    expect(areaKeyOf('services/billing/main.go')).toBe('services/billing')
    expect(areaKeyOf('packages/index.ts')).toBe('packages')
  })
})

describe('groupAreas', () => {
  test('keeps a small change in one area', () => {
    const areas = groupAreas([changed('web/a.ts'), changed('api/b.go')])
    expect(areas).toHaveLength(1)
    expect(areas[0]?.keys).toEqual(['web', 'api'])
  })

  test('splits a large change into at most MAX_AREAS areas by directory', () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      changed(`services/svc${i}/main.go`, 100 + i * 10),
    )
    const areas = groupAreas(files)
    expect(areas).toHaveLength(MAX_AREAS)
    expect(areas.flatMap((area) => area.files)).toHaveLength(12)
    for (const area of areas)
      expect(new Set(area.files.map((file) => areaKeyOf(file.path))).size).toBe(area.keys.length)
    expect(areas[0]?.files.length).toBeGreaterThanOrEqual(1)
  })

  test('orders areas by weight and names them by their keys', () => {
    const areas = groupAreas([
      ...Array.from({ length: 15 }, (_, i) => changed(`web/f${i}.ts`, 40)),
      ...Array.from({ length: 10 }, (_, i) => changed(`api/f${i}.go`, 10)),
    ])
    expect(areas.map((area) => area.name)).toEqual(['web', 'api'])
  })

  test('splits one heavy directory by its subdirectories', () => {
    const areas = groupAreas([
      ...Array.from({ length: 10 }, (_, i) => changed(`lib/widgets/w${i}.ts`, 100)),
      ...Array.from({ length: 10 }, (_, i) => changed(`lib/gadgets/g${i}.ts`, 100)),
    ])
    expect(areas.map((area) => area.name).toSorted()).toEqual(['lib/gadgets', 'lib/widgets'])
  })

  test('cuts files of one directory into halves until they fit or the areas run out', () => {
    const files = Array.from({ length: 40 }, (_, i) => changed(`lib/f${i}.ts`, 200))
    const areas = groupAreas(files)
    expect(areas).toHaveLength(MAX_AREAS)
    expect(areas.flatMap((area) => area.files)).toHaveLength(40)
    expect(new Set(areas.flatMap((area) => area.files.map((file) => file.path))).size).toBe(40)
  })
})
