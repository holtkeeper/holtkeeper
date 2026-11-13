import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ToolContext } from '@holtkeeper/agent'

import { codeTools, lockfileTools } from '../src/index.ts'
import { call } from './fixture.ts'

const padding = Object.fromEntries(
  Array.from({ length: 9000 }, (_, i) => [
    `node_modules/filler-part-${i}`,
    {
      version: '1.0.0',
      resolved: `https://registry.example.com/filler-part-${i}/-/filler-part-${i}-1.0.0.tgz`,
      integrity: `sha512-${'a'.repeat(40)}`,
    },
  ]),
)

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shapes-root', workspaces: ['packages/*'] }),
  'packages/circle/package.json': JSON.stringify({
    name: '@shapes/circle',
    dependencies: { 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' },
  }),
  'package-lock.json': JSON.stringify(
    {
      name: 'shapes-root',
      lockfileVersion: 3,
      packages: {
        '': { name: 'shapes-root', workspaces: ['packages/*'] },
        'packages/circle': { name: '@shapes/circle', dependencies: { 'color-kit': '^2.1.0' } },
        'node_modules/@shapes/circle': { resolved: 'packages/circle', link: true },
        'node_modules/color-kit': { version: '2.3.0' },
        'packages/circle/node_modules/color-kit': { version: '2.1.5' },
        ...padding,
      },
    },
    null,
    2,
  ),
  'tools/yarn.lock': '# yarn lockfile v1\n\ncolor-kit@^1.0.0:\n  version "1.4.0"\n',
  'tools/package.json': JSON.stringify({
    name: 'shape-tools',
    dependencies: { 'color-kit': '^1.0.0' },
  }),
  'services/api/go.mod':
    'module example.com/shapes/api\n\ngo 1.23\n\nrequire (\n\texample.com/colors v1.2.0\n\texample.com/hue v0.3.0 // indirect\n)\n\nreplace example.com/hue => example.com/hue-fork v0.3.1\n',
  'services/api/go.sum':
    'example.com/colors v1.2.0 h1:aaa=\nexample.com/colors v1.2.0/go.mod h1:bbb=\nexample.com/colors v1.1.0/go.mod h1:ccc=\n',
}

let dir: string
let ctx: ToolContext
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lockfiles-'))
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), text)
    }),
  )
  ctx = { dir, signal: new AbortController().signal }
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const lockfiles = lockfileTools()
const resolve = (input: Record<string, unknown>) => call(lockfiles, 'lockfiles.resolve', input, ctx)

describe('lockfiles.resolve', () => {
  test('parses a lockfile over the search limit in full and reports each workspace', async () => {
    const out = await resolve({ package: 'color-kit' })
    expect(out).toMatch(/package-lock\.json \(npm lockfile, \d\.\d MB, parsed in full\)/)
    expect(out).toContain('resolved versions: 2.1.5, 2.3.0')
    expect(out).toContain(
      'packages/circle/package.json: prod ^2.1.0; lockfile records ^2.1.0, resolves 2.1.5',
    )
    expect(out).toContain('tools/yarn.lock (yarn lockfile')
    expect(out).toContain('tools/package.json: prod ^1.0.0; lockfile resolves 1.4.0')
  })

  test('says when a package is not present and when the lockfile does not resolve a declaration', async () => {
    const out = await resolve({ package: 'left-widget', path: 'packages/circle' })
    expect(out).not.toContain('tools/yarn.lock')
    expect(out).toContain('left-widget is not present in this lockfile')
    expect(out).toContain(
      'packages/circle/package.json: prod ^1.0.0; the lockfile does not resolve it',
    )
  })

  test('suggests similar names for a miss', async () => {
    expect(await resolve({ package: 'color', path: 'tools' })).toContain('similar names: color-kit')
  })

  test('reads go.mod requires, replacements and go.sum entries', async () => {
    const colors = await resolve({ package: 'example.com/colors/palette' })
    expect(colors).toContain('services/api/go.mod (module example.com/shapes/api)')
    expect(colors).toContain('requires example.com/colors v1.2.0')
    expect(colors).toContain(
      'example.com/colors v1.1.0 (go.mod), example.com/colors v1.2.0 (go.mod + module)',
    )
    const hue = await resolve({ package: 'example.com/hue' })
    expect(hue).toContain('requires example.com/hue v0.3.0 (indirect)')
    expect(hue).toContain('replaced by example.com/hue-fork v0.3.1')
    expect(hue).toContain('go.sum has no entry for it')
    expect(await resolve({ package: 'example.com/sizes' })).toContain(
      'example.com/sizes is not required by go.mod',
    )
  })

  test('fails clearly when no lockfile covers the path', async () => {
    expect(resolve({ package: 'example.com/colors', path: 'packages/circle' })).rejects.toThrow(
      'no go.mod covers packages/circle',
    )
  })
})

describe('large files in the code tools', () => {
  const code = codeTools()

  test('grep names the files it skipped for size and points at lockfiles.resolve', async () => {
    const out = await call(code, 'code.grep', { query: 'color-kit' }, ctx)
    expect(out).toMatch(
      /not searched: 1 file over 1\.0 MB: package-lock\.json \(\d\.\d MB\); query lockfiles/,
    )
    expect(out).toContain('lockfiles.resolve')
    expect(out).toContain('tools/yarn.lock')
    const none = await call(code, 'code.grep', { query: 'no-such-text', paths: ['*.json'] }, ctx)
    expect(none).toStartWith('no matches in 1 files\nnot searched: 1 file over 1.0 MB')
  })

  test('read returns a bounded slice of a large file with a note', async () => {
    const out = await call(code, 'code.read', { path: 'package-lock.json', start: 1, end: 3 }, ctx)
    expect(out).toMatch(/^package-lock\.json is \d\.\d MB: the search tools skip it/)
    expect(out).toContain('query it with lockfiles.resolve')
    expect(out).toContain('package-lock.json 1-3 of ')
    expect(out).toContain('2|   "name": "shapes-root",')
  })

  test('read says why it refuses a binary or missing file', async () => {
    await writeFile(join(dir, 'blob.bin'), new Uint8Array([0, 1, 2, 0]))
    expect(call(code, 'code.read', { path: 'blob.bin' }, ctx)).rejects.toThrow('blob.bin is binary')
    expect(call(code, 'code.read', { path: 'gone.ts' }, ctx)).rejects.toThrow('gone.ts is missing')
  })
})
