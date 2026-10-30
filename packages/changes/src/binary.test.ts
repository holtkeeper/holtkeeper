import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CommitInput, GitForge } from '@holtkeeper/forge'

import { type FileAccess, planChanges, sha256Hex } from './apply.ts'
import { changeDiff, unifiedDiff } from './diff.ts'
import { applyToDisk } from './disk.ts'
import { openMergeRequest } from './merge-request.ts'
import type { CodeChange, Edit } from './types.ts'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe])
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const change = (id: string, edits: Edit[]): CodeChange => ({
  id,
  title: `Change ${id}`,
  confidence: 'review',
  source: 'media',
  edits,
})

const replaceHero = (previous: Uint8Array, next = webp): Edit => ({
  kind: 'write-binary',
  file: 'img/hero.png',
  bytes: next.byteLength,
  base64: b64(next),
  previousSha256: sha256Hex(previous),
})

const memory = (files: Record<string, Uint8Array>): FileAccess => ({
  read: async (file) => files[file] && new TextDecoder().decode(files[file]),
  readBytes: async (file) => files[file],
})

describe('write-binary', () => {
  test('replaces a file whose hash matches and conflicts when it moved on', async () => {
    const plan = await planChanges(
      [change('ok', [replaceHero(png)]), change('stale', [replaceHero(new Uint8Array([1]))])],
      memory({ 'img/hero.png': png }),
    )
    expect(plan.applied).toEqual(['ok'])
    expect(plan.conflicts.map((c) => c.reason)).toEqual([
      'the file changed since the suggestion was made',
    ])
    expect(plan.files).toEqual([
      { file: 'img/hero.png', content: undefined, bytes: webp, existed: true },
    ])
  })

  test('refuses to overwrite without a hash and needs a hash for missing files', async () => {
    const create: Edit = { kind: 'write-binary', file: 'img/hero.png', bytes: 6, base64: b64(webp) }
    const existing = await planChanges([change('new', [create])], memory({ 'img/hero.png': png }))
    expect(existing.conflicts[0]?.reason).toBe('file already exists')
    const missing = await planChanges([change('replace', [replaceHero(png)])], memory({}))
    expect(missing.conflicts[0]?.reason).toBe('file not found')
    const created = await planChanges([change('new', [create])], memory({}))
    expect(created.files[0]).toMatchObject({ existed: false, bytes: webp })
  })

  test('resolves artifacts and checks their size', async () => {
    const edit: Edit = { kind: 'write-binary', file: 'a.webp', bytes: 6, artifact: 'abc' }
    const resolved = await planChanges([change('a', [edit])], memory({}), {
      resolveArtifact: (id) => (id === 'abc' ? webp : undefined),
    })
    expect(resolved.files[0]?.bytes).toEqual(webp)
    const gone = await planChanges([change('a', [edit])], memory({}), {
      resolveArtifact: async () => undefined,
    })
    expect(gone.conflicts[0]?.reason).toBe('the binary content is not available')
    const wrong = await planChanges([change('a', [{ ...edit, bytes: 3 }])], memory({}), {
      resolveArtifact: () => webp,
    })
    expect(wrong.conflicts[0]?.reason).toBe('the binary content does not match its size')
  })

  test('text edits to a file written as binary in the same plan conflict', async () => {
    const plan = await planChanges(
      [
        change('bin', [{ kind: 'write-binary', file: 'a.svg', bytes: 6, base64: b64(webp) }]),
        change('txt', [{ kind: 'create', file: 'a.svg', newText: '<svg/>' }]),
      ],
      memory({}),
    )
    expect(plan.conflicts.map((c) => [c.changeId, c.reason])).toEqual([
      ['txt', 'the file is binary'],
    ])
  })

  test('diffs show binaries by size and patches list them in a note', () => {
    expect(changeDiff(change('a', [replaceHero(png)]))).toEqual([
      { file: 'img/hero.png', status: 'binary', hunks: [], binary: { after: 6 } },
    ])
    const patch = unifiedDiff([
      { file: 'a.ts', before: 'a\n', after: 'b\n' },
      { file: 'img/hero.png', before: 'x', after: undefined, bytes: webp },
    ])
    expect(patch).toContain('+++ b/a.ts')
    expect(patch).not.toContain('b/img/hero.png')
    expect(patch).toEndWith(
      '# Binary files not included in this patch:\n#   img/hero.png (6 bytes, replaced)\n',
    )
  })
})

describe('applyToDisk with binaries', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-binary-'))
    await Bun.write(join(dir, 'img/hero.png'), png)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('writes the exact bytes', async () => {
    const plan = await applyToDisk(
      dir,
      [
        change('a', [
          replaceHero(png),
          { kind: 'write-binary', file: 'img/hero.webp', bytes: 6, artifact: 'x' },
        ]),
      ],
      { resolveArtifact: () => webp },
    )
    expect(plan.conflicts).toEqual([])
    expect(new Uint8Array(await Bun.file(join(dir, 'img/hero.png')).arrayBuffer())).toEqual(webp)
    expect(new Uint8Array(await Bun.file(join(dir, 'img/hero.webp')).arrayBuffer())).toEqual(webp)
  })
})

describe('openMergeRequest with binaries', () => {
  test('reads bytes from the forge and commits base64', async () => {
    const commits: CommitInput[] = []
    const forge = {
      getRepository: async () => ({ defaultBranch: 'main' }),
      readFile: async () => 'garbled text',
      readFileBytes: async (_repo: string, file: string) =>
        file === 'img/hero.png' ? png : undefined,
      commit: async (_repo: string, input: CommitInput) => {
        commits.push(input)
        return { sha: 'abc', webUrl: '' }
      },
      createMergeRequest: async () => ({ id: 1, webUrl: 'https://forge.test/mr/1' }),
    } as unknown as GitForge
    const outcome = await openMergeRequest({
      forge,
      repo: 'games/a',
      title: 'Optimize hero',
      changes: [change('a', [replaceHero(png)])],
    })
    expect(outcome.plan.applied).toEqual(['a'])
    expect(commits[0]?.changes).toEqual([
      { action: 'update', path: 'img/hero.png', content: b64(webp), encoding: 'base64' },
    ])
  })
})
