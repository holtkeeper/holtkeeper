import { describe, expect, test } from 'bun:test'

import { remapPaths } from './apply.ts'
import {
  changedSymbols,
  distinctiveAdditions,
  fileDiff,
  formatPatch,
  parsePatch,
  remapFiles,
} from './patch.ts'

const patch = `diff --git a/src/auth/login.ts b/src/auth/login.ts
index 0ff3bbb..694af38 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -3,4 +3,5 @@ export function login(user: string, password: string) {
 export function login(user: string, password: string) {
   if (!user) throw new Error('missing user')
+  if (!password) throw new Error('missing password')
   return checkCredentials(user, password)
 }
diff --git a/src/auth/session.ts b/src/auth/session.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/auth/session.ts
@@ -0,0 +1 @@
+export const sessionTimeout = 3600
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
diff --git a/logo.png b/logo.png
index 1..2 100644
Binary files a/logo.png and b/logo.png differ
`

describe('parsePatch', () => {
  const files = parsePatch(patch)

  test('reads paths, statuses and bodies', () => {
    expect(
      files.map((file) => [file.oldPath, file.newPath, file.status, Boolean(file.binary)]),
    ).toEqual([
      ['src/auth/login.ts', 'src/auth/login.ts', 'modified', false],
      ['src/auth/session.ts', 'src/auth/session.ts', 'added', false],
      ['old.txt', 'new.txt', 'renamed', false],
      ['logo.png', 'logo.png', 'modified', true],
    ])
    expect(files[0]?.diff.startsWith('@@ -3,4 +3,5 @@')).toBe(true)
  })

  test('formats back without index lines unless blobs are given, leaving binaries out', () => {
    const text = formatPatch(files)
    expect(text).not.toContain('index ')
    expect(text).not.toContain('logo.png')
    expect(text).toContain(
      'new file mode 100644\n--- /dev/null\n+++ b/src/auth/session.ts\n@@ -0,0 +1 @@',
    )
    expect(text).toContain('rename from old.txt\nrename to new.txt\n')
    expect(parsePatch(text).map((file) => file.newPath)).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts',
      'new.txt',
    ])
    const blob = 'a'.repeat(40)
    expect(formatPatch(files.slice(0, 1), new Map([[0, blob]]))).toContain(
      `index ${blob}..${'0'.repeat(40)} 100644\n`,
    )
  })

  test('finds changed symbols and distinctive additions', () => {
    expect(changedSymbols(files)).toContain('checkCredentials')
    expect(changedSymbols(files)).not.toContain('function')
    expect(distinctiveAdditions(files)).toEqual([
      "if (!password) throw new Error('missing password')",
      'export const sessionTimeout = 3600',
    ])
  })

  test('renders hunks for reports', () => {
    expect(fileDiff(files[0]!)).toMatchObject({
      file: 'src/auth/login.ts',
      status: 'modified',
      hunks: [{ oldStart: 3, oldLines: 4, newStart: 3, newLines: 5 }],
    })
    expect(fileDiff(files[0]!).hunks[0]?.lines.filter((line) => line.kind === 'add')).toHaveLength(
      1,
    )
  })
})

describe('remapPaths', () => {
  const files = parsePatch(patch).slice(0, 2)

  test('maps missing files to the same name and moves new files along', () => {
    const mappings = remapPaths(files, ['packages/web/src/login.ts', 'README.md'])
    expect(mappings).toEqual([
      { from: 'src/auth/login.ts', to: 'packages/web/src/login.ts' },
      { from: 'src/auth/session.ts', to: 'packages/web/src/session.ts' },
    ])
    expect(remapFiles(files, mappings).map((file) => file.newPath)).toEqual([
      'packages/web/src/login.ts',
      'packages/web/src/session.ts',
    ])
  })

  test('prefers the longest common suffix and gives up on ties', () => {
    expect(remapPaths(files.slice(0, 1), ['a/auth/login.ts', 'b/login.ts'])).toEqual([
      { from: 'src/auth/login.ts', to: 'a/auth/login.ts' },
    ])
    expect(remapPaths(files.slice(0, 1), ['a/login.ts', 'b/login.ts'])).toEqual([])
    expect(remapPaths(files.slice(0, 1), ['src/auth/login.ts'])).toEqual([])
  })
})
