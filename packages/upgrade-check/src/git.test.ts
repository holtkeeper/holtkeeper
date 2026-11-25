import { describe, expect, test } from 'bun:test'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { commitSubjects, diffFilesSource, gitRangeSource, resolveCommit } from './git.ts'

const FROM = 'a'.repeat(40)
const TO = 'b'.repeat(40)

const args = (command: string[]) => command.slice(4)

describe('resolveCommit', () => {
  test('resolves a local ref without fetching', async () => {
    const { runner, calls } = createFakeRunner((command) =>
      args(command)[0] === 'rev-parse' ? { stdout: `${TO}\n` } : undefined,
    )
    expect(await resolveCommit({ runner, dir: '/w' }, 'v2.0.0')).toBe(TO)
    expect(calls).toHaveLength(1)
  })

  test('never fetches and stops options from being read as a ref', async () => {
    const { runner, calls } = createFakeRunner(() => ({ exitCode: 1 }))
    expect(await resolveCommit({ runner, dir: '/w' }, FROM)).toBeUndefined()
    expect(await resolveCommit({ runner, dir: '/w' }, '--upload-pack=x')).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toContain('--end-of-options')
    expect(calls[0]?.command).toContain('--literal-pathspecs')
  })
})

describe('gitRangeSource', () => {
  test('lists changed files and reads diffs of the requested paths', async () => {
    const { runner, calls } = createFakeRunner((command) => {
      const rest = args(command)
      if (rest.includes('--name-status')) return { stdout: 'M\0src/widget.ts\0A\0src/gadget.ts\0' }
      if (rest.includes('--numstat'))
        return { stdout: '1\t1\tsrc/widget.ts\x004\t0\tsrc/gadget.ts\0' }
      return {
        stdout: [
          'diff --git a/src/widget.ts b/src/widget.ts',
          '--- a/src/widget.ts',
          '+++ b/src/widget.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
          '',
        ].join('\n'),
      }
    })
    const source = await gitRangeSource({ runner, dir: '/w' }, FROM, TO)
    expect(source.files.map((file) => [file.path, file.status, file.added])).toEqual([
      ['src/widget.ts', 'modified', 1],
      ['src/gadget.ts', 'added', 4],
    ])
    const diffs = await source.diffs(['src/widget.ts', 'unknown.ts'])
    expect(diffs.map((file) => file.newPath)).toEqual(['src/widget.ts'])
    expect(args(calls.at(-1)?.command ?? [])).toEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      FROM,
      TO,
      '--',
      'src/widget.ts',
    ])
  })

  test('rejects when git diff fails', async () => {
    const { runner } = createFakeRunner(() => ({ exitCode: 128, stderr: 'bad object' }))
    const error = await gitRangeSource({ runner, dir: '/w' }, FROM, TO).catch(
      (reason: unknown) => reason,
    )
    expect(String(error)).toContain('bad object')
  })
})

describe('diffFilesSource', () => {
  test('counts lines of forge diffs', async () => {
    const source = diffFilesSource([
      {
        oldPath: 'src/old.ts',
        newPath: 'src/old.ts',
        status: 'deleted',
        diff: '@@ -1,2 +0,0 @@\n-a\n-b\n',
      },
    ])
    expect(source.files).toEqual([
      {
        path: 'src/old.ts',
        oldPath: 'src/old.ts',
        status: 'deleted',
        added: 0,
        deleted: 2,
        binary: false,
      },
    ])
    expect(await source.diffs(['src/old.ts'])).toHaveLength(1)
  })
})

describe('commitSubjects', () => {
  test('lists subjects and is empty when git fails', async () => {
    const ok = createFakeRunner(() => ({ stdout: 'feat: add widgets\nfix: round prices\n' }))
    expect(await commitSubjects({ runner: ok.runner, dir: '/w' }, FROM, TO)).toEqual([
      'feat: add widgets',
      'fix: round prices',
    ])
    const failing = createFakeRunner(() => ({ exitCode: 1 }))
    expect(await commitSubjects({ runner: failing.runner, dir: '/w' }, FROM, TO)).toEqual([])
  })
})
