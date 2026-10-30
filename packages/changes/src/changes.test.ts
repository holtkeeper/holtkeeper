import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyReplacements, offsetOf, planChanges } from './apply.ts'
import { changeDiff, unifiedDiff } from './diff.ts'
import { applyToDisk } from './disk.ts'
import type { CodeChange } from './types.ts'

const source = 'const maxRetries = 3\nexport function load() {\n  return maxRetries\n}\n'

const rename: CodeChange = {
  id: 'rename-max-retries',
  title: 'Rename maxRetries to MAX_RETRIES',
  confidence: 'review',
  source: 'conventions',
  edits: [
    {
      kind: 'replace',
      file: 'src/a.ts',
      range: { start: { line: 1, column: 7 }, end: { line: 1, column: 17 } },
      oldText: 'maxRetries',
      newText: 'MAX_RETRIES',
    },
    {
      kind: 'replace',
      file: 'src/a.ts',
      range: { start: { line: 3, column: 10 }, end: { line: 3, column: 20 } },
      oldText: 'maxRetries',
      newText: 'MAX_RETRIES',
    },
  ],
}

const createTest: CodeChange = {
  id: 'test-load',
  title: 'Add a test for load',
  confidence: 'review',
  source: 'claude',
  edits: [{ kind: 'create', file: 'src/a.test.ts', newText: "test('load', () => {})\n" }],
}

const memory = (files: Record<string, string>) => ({ read: async (file: string) => files[file] })

describe('offsets and replacements', () => {
  test('maps 1-based positions', () => {
    expect(offsetOf(source, { line: 1, column: 1 })).toBe(0)
    expect(offsetOf(source, { line: 2, column: 1 })).toBe(21)
    expect(offsetOf(source, { line: 9, column: 1 })).toBeUndefined()
  })

  test('applies several edits and rejects stale or overlapping ones', () => {
    const replaces = rename.edits.filter((e) => e.kind === 'replace')
    expect(applyReplacements(source, replaces)).toEqual({
      text: source.replaceAll('maxRetries', 'MAX_RETRIES'),
    })
    expect(applyReplacements(source.replace('maxRetries', 'retries'), replaces)).toEqual({
      error: 'the file changed since the suggestion was made',
    })
    const [first] = replaces
    if (!first) throw new Error('missing edit')
    expect(applyReplacements(source, [first, { ...first, newText: 'X' }])).toEqual({
      error: 'edits overlap',
    })
  })
})

describe('planChanges', () => {
  test('applies what it can and reports conflicts', async () => {
    const stale: CodeChange = {
      ...rename,
      id: 'stale',
      edits: [{ ...rename.edits[0]!, oldText: 'other' } as CodeChange['edits'][number]],
    }
    const plan = await planChanges(
      [rename, createTest, stale, { ...createTest, id: 'again' }],
      memory({ 'src/a.ts': source }),
    )
    expect(plan.applied).toEqual(['rename-max-retries', 'test-load'])
    expect(plan.conflicts.map((c) => [c.changeId, c.reason])).toEqual([
      ['stale', 'the file changed since the suggestion was made'],
      ['again', 'file already exists'],
    ])
    expect(plan.files.find((f) => f.file === 'src/a.ts')?.content).toContain('MAX_RETRIES')
  })
})

describe('several changes to one file', () => {
  test('combine when independent and conflict only when they overlap', async () => {
    const [first, second] = rename.edits.filter((e) => e.kind === 'replace')
    if (!first || !second) throw new Error('missing edits')
    const a: CodeChange = { ...rename, id: 'a', edits: [first] }
    const b: CodeChange = { ...rename, id: 'b', edits: [second] }
    const overlapping: CodeChange = { ...rename, id: 'c', edits: [{ ...first, newText: 'LIMIT' }] }
    const plan = await planChanges([b, a, overlapping], memory({ 'src/a.ts': source }))
    expect(plan.applied).toEqual(['b', 'a'])
    expect(plan.conflicts.map((c) => [c.changeId, c.reason])).toEqual([['c', 'edits overlap']])
    expect(plan.files[0]?.content).toBe(source.replaceAll('maxRetries', 'MAX_RETRIES'))
  })
})

describe('diffs', () => {
  test('renders changes from their own snippets', () => {
    const [modified] = changeDiff(rename)
    expect(modified?.status).toBe('modified')
    expect(
      modified?.hunks.map((h) => [h.oldStart, h.lines.map((l) => `${l.kind}:${l.text}`)]),
    ).toEqual([
      [1, ['remove:maxRetries', 'add:MAX_RETRIES']],
      [3, ['remove:maxRetries', 'add:MAX_RETRIES']],
    ])
    expect(changeDiff(createTest)[0]).toMatchObject({ status: 'added', hunks: [{ newLines: 1 }] })
  })

  test('builds a unified diff git can apply', () => {
    const patch = unifiedDiff([
      { file: 'src/a.ts', before: source, after: source.replace('3', '5') },
      { file: 'src/new.ts', before: undefined, after: 'x\n' },
    ])
    expect(patch).toContain(
      '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,4 @@\n-const maxRetries = 3\n+const maxRetries = 5',
    )
    expect(patch).toContain('new file mode 100644\n--- /dev/null\n+++ b/src/new.ts')
  })
})

describe('applyToDisk', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-changes-'))
    await Bun.write(join(dir, 'src/a.ts'), source)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('keeps a byte order mark', async () => {
    await Bun.write(join(dir, 'src/a.ts'), `\uFEFF${source}`)
    await applyToDisk(dir, [rename])
    const bytes = new Uint8Array(await Bun.file(join(dir, 'src/a.ts')).arrayBuffer())
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(await Bun.file(join(dir, 'src/a.ts')).text()).toContain('MAX_RETRIES')
  })

  test('writes applied changes and refuses paths outside the checkout', async () => {
    const plan = await applyToDisk(dir, [rename, createTest])
    expect(plan.conflicts).toEqual([])
    expect(await Bun.file(join(dir, 'src/a.ts')).text()).toContain('return MAX_RETRIES')
    expect(await Bun.file(join(dir, 'src/a.test.ts')).exists()).toBe(true)
    expect(
      applyToDisk(dir, [
        { ...createTest, edits: [{ kind: 'create', file: '../evil.ts', newText: '' }] },
      ]),
    ).rejects.toThrow('escapes')
  })
})
