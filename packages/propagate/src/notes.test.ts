import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fakeForge } from '../test/fakes.ts'
import { chainNotes, changelogExcerpt, forgeNotes, nodeModulesNotes, trimText } from './notes.ts'

const changelog = `# Changelog

## [3.0.0] - 2026-09-01

### Breaking

- drop Node 18

## 2.1.0

- add \`size\` prop

### 2.0.1 fix inside

- detail

## v2.0.0

- \`greet\` takes options

## 1.4.0

- old
`

describe('changelogExcerpt', () => {
  test('keeps sections in (from, to]', () => {
    const excerpt = changelogExcerpt(changelog, '1.4.0', '2.1.0')!
    expect(excerpt.startsWith('## 2.1.0')).toBe(true)
    expect(excerpt).toContain('### 2.0.1 fix inside')
    expect(excerpt).toContain('`greet` takes options')
    expect(excerpt).not.toContain('drop Node 18')
    expect(excerpt).not.toContain('old')
    expect(changelogExcerpt(changelog, '3.0.0', '3.0.0')).toBeUndefined()
  })

  test('trimText cuts at a line', () => {
    expect(trimText('a\nbbbb\ncccc', 8)).toBe('a\nbbbb\n\n…')
  })
})

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

describe('sources', () => {
  test('node_modules changelog and migration guide', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'propagate-notes-'))
    dirs.push(dir)
    await mkdir(join(dir, 'node_modules/@acme/ui'), { recursive: true })
    await writeFile(join(dir, 'node_modules/@acme/ui/CHANGELOG.md'), changelog)
    await writeFile(join(dir, 'node_modules/@acme/ui/MIGRATION.md'), '# Migrating\n\nUse options.')
    const notes = await nodeModulesNotes().notes({
      dir,
      package: '@acme/ui',
      ecosystem: 'npm',
      from: '1.4.0',
      to: '2.0.0',
    })
    expect(notes?.source).toBe('node_modules/@acme/ui')
    expect(notes?.text).toContain('`greet` takes options')
    expect(notes?.text).toContain('Use options.')
    expect(notes?.text).not.toContain('2.1.0')
  })

  test('forge changelog at the target tag, else tag names', async () => {
    const { forge, reads } = fakeForge(
      { 'libs/ui': {}, 'libs/bare': {} },
      {
        tags: {
          'libs/ui': [{ name: 'v2.0.0', sha: 'a', committedAt: '2026-01-01' }],
          'libs/bare': [
            { name: 'v2.0.0', sha: 'a', committedAt: '2026-01-02' },
            { name: 'v1.5.0', sha: 'b', committedAt: '2026-01-01' },
            { name: 'v1.0.0', sha: 'c', committedAt: '2025-01-01' },
          ],
        },
        refs: { 'libs/ui': { 'v2.0.0': { 'CHANGELOG.md': changelog } } },
      },
    )
    const source = forgeNotes({
      forge,
      forgeId: 'work',
      sources: { '@acme/ui': 'work:libs/ui', bare: 'libs/bare', other: 'gh:x/y' },
    })
    const input = { dir: '/nowhere', ecosystem: 'npm' as const, from: '1.4.0', to: '2.0.0' }
    const ui = await source.notes({ ...input, package: '@acme/ui' })
    expect(ui?.source).toBe('work:libs/ui@v2.0.0')
    expect(ui?.text).toContain('`greet` takes options')
    expect(reads).toContain('libs/ui:CHANGELOG.md@v2.0.0')
    const bare = await source.notes({ ...input, package: 'bare' })
    expect(bare?.text).toContain('- v2.0.0\n- v1.5.0')
    expect(bare?.text).not.toContain('v1.0.0')
    expect(await source.notes({ ...input, package: 'other' })).toBeUndefined()
    expect(await source.notes({ ...input, package: 'unmapped' })).toBeUndefined()
  })

  test('chainNotes returns the first answer and skips failures', async () => {
    const chain = chainNotes([
      { notes: () => Promise.reject(new Error('boom')) },
      { notes: async () => undefined },
      {
        notes: async (input) => ({ package: input.package, to: input.to, source: 's', text: 't' }),
      },
    ])
    expect(await chain.notes({ dir: '/', package: 'p', ecosystem: 'npm', to: '1.0.0' })).toEqual({
      package: 'p',
      to: '1.0.0',
      source: 's',
      text: 't',
    })
  })
})
