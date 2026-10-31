import { describe, expect, test } from 'bun:test'

import { memoryArtifactStore } from '@holtkeeper/artifacts'
import type { LibraryRecord, LibraryStore } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { fakeGitHub, tarball } from '../test/fixtures.ts'
import { libraryApi } from './api.ts'
import { indexLibraries } from './indexer.ts'
import type { SiteSource } from './sources/site.ts'
import {
  type ArchiveFiles,
  type LibraryIndexSettings,
  type LibraryRegistry,
  type LibraryUse,
  defaultLibraryIndexSettings,
} from './types.ts'

const encoder = new TextEncoder()
const files = (entries: Record<string, string>): ArchiveFiles =>
  new Map(Object.entries(entries).map(([path, text]) => [path, encoder.encode(text)]))

const ref = { ecosystem: 'npm', name: 'lib' } as const
const repository = { host: 'github.com', path: 'acme/lib', url: 'https://github.com/acme/lib' }

function fakeRegistry(options: { failArchive?: string } = {}) {
  const archives: string[] = []
  const registry: LibraryRegistry = {
    async library(target) {
      if (target.name !== 'lib') return undefined
      return {
        ...ref,
        description: 'The lib',
        repository,
        latest: '2.0.0',
        versions: [
          { version: '1.0.0', publishedAt: '2024-01-01T00:00:00.000Z' },
          { version: '1.1.0', publishedAt: '2024-06-01T00:00:00.000Z', deprecated: 'old' },
          { version: '2.0.0', publishedAt: '2025-01-01T00:00:00.000Z', commit: 'c200' },
        ],
      }
    },
    async archive(_target, version) {
      archives.push(version)
      if (version === options.failArchive) throw new Error('registry down')
      return files({
        'package.json': JSON.stringify({ name: 'lib', version, types: 'index.d.ts' }),
        'index.d.ts': `/** Adds. */\nexport declare function add${version.replaceAll('.', '')}(a: number): number\n`,
        'README.md': `# lib\n\nVersion ${version} readme.\n\n## Usage\n\nCall add.`,
        'CHANGELOG.md':
          '# Changelog\n\n## 2.0.0\n\nBreaking: removed sub.\n\n## 1.1.0\n\nAdded mul.\n\n## 1.0.0\n\nFirst.',
        'LICENSE.md': 'MIT',
      })
    },
  }
  return { registry, archives }
}

const github = async () =>
  fakeGitHub(
    {
      '/repos/acme/lib': { size: 100 },
      '/repos/acme/lib/tags?per_page=100': [
        { name: 'v1.0.0', commit: { sha: 's100' } },
        { name: 'v1.1.0', commit: { sha: 's110' } },
        { name: 'v2.0.0', commit: { sha: 's200' } },
      ],
      '/repos/acme/lib/releases?per_page=100': [
        { tag_name: 'v2.0.0', name: 'v2.0.0', body: '## Breaking\n\nRemoved sub.' },
        { tag_name: 'v1.2.0', name: 'v1.2.0', body: 'Between.' },
        { tag_name: 'v1.1.0', name: 'v1.1.0', body: 'Added mul.' },
        { tag_name: 'v0.9.0', name: 'v0.9.0', body: 'Too old.' },
      ],
    },
    {
      '/repos/acme/lib/tarball/v1.0.0': await tarball('acme-lib-s100', {
        'docs/guide.md': '# Guide\n\nGuide for 1.0.',
        'src/index.ts': 'export const x = 1',
      }),
      '/repos/acme/lib/tarball/v1.1.0': await tarball('acme-lib-s110', {
        'docs/guide.md': '# Guide\n\nGuide for 1.1.',
      }),
      '/repos/acme/lib/tarball/v2.0.0': await tarball('acme-lib-s200', {
        'docs/guide.md': '# Guide\n\nGuide for 2.0.',
        'docs/migration.md': '# Migrating to v2\n\nRename sub to minus.',
        'llms.txt': '# lib\n\n> Short docs.',
      }),
    },
  )

const settings: LibraryIndexSettings = {
  ...defaultLibraryIndexSettings,
  sources: { ...defaultLibraryIndexSettings.sources, issues: false },
}

const uses = (...entries: [string, string, string?][]): LibraryUse[] =>
  entries.map(([name, version, repo]) => ({
    ecosystem: 'npm',
    name,
    version,
    repo: repo ?? 'gl:a',
  }))

const day = 86_400_000
const at = (days: number) => () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + days * day)

const librariesOf = (): LibraryStore => {
  const store = memoryStore().libraries
  if (!store) throw new Error('memory store has no libraries')
  return store
}

describe('indexLibraries', () => {
  test('indexes the matrix with every source, then fetches nothing it has', async () => {
    const store = librariesOf()
    const artifacts = memoryArtifactStore()
    const { registry, archives } = fakeRegistry()
    const client = await github()
    const input = {
      store,
      artifacts,
      registries: { npm: registry },
      github: client,
      uses: uses(['lib', '1.0.0'], ['@types/node', '20.0.0'], ['internal', '1.0.0']),
      settings,
      isInternal: (target: { name: string }) => target.name === 'internal',
      now: at(0),
    }
    const summary = await indexLibraries(input)
    expect(summary).toEqual({
      libraries: 1,
      versionsAdded: 3,
      versionsRemoved: 0,
      librariesRemoved: 0,
      failures: [],
    })
    const library = await store.getLibrary(ref)
    expect(library?.repository).toEqual(repository)
    expect(library?.latest).toBe('2.0.0')
    expect(library?.sources.registry?.status).toBe('ok')
    expect((await store.listLibraries()).map((item) => item.name)).toEqual(['lib'])

    const versions = await store.listVersions(ref)
    expect(versions.map((record) => [record.version, record.roles, record.usedBy])).toEqual([
      ['2.0.0', ['latest', 'major', 'first'], []],
      ['1.1.0', ['minor'], []],
      ['1.0.0', ['used', 'patch'], ['gl:a']],
    ])
    for (const record of versions) {
      expect(
        Object.fromEntries(
          Object.entries(record.sources).map(([key, value]) => [key, value?.status]),
        ),
      ).toEqual({
        archive: 'ok',
        api: 'ok',
        repository: 'ok',
        releases: 'ok',
      })
      expect(record.tag).toBe(`v${record.version}`)
    }
    expect(versions[0]?.commit).toBe('c200')
    expect(versions[1]?.deprecated).toBe('old')

    const api = await libraryApi({ store, artifacts }).get(ref, '1.1.0')
    expect(api?.[0]?.entries[0]?.symbols.map((symbol) => symbol.name)).toEqual(['add110'])
    expect(await libraryApi({ store, artifacts }).versions(ref)).toEqual([
      '2.0.0',
      '1.1.0',
      '1.0.0',
    ])
    const stored = await artifacts.stat(versions[0]?.api ?? '')
    expect(stored?.tags).toEqual({
      kind: 'library',
      library: 'npm:lib',
      version: '2.0.0',
      content: 'api',
    })

    const archive = await store.listChunks({ ...ref, source: 'archive', path: 'README.md' })
    expect(archive.map((chunk) => chunk.versions.join(',')).toSorted()).toEqual([
      '1.0.0',
      '1.1.0',
      '2.0.0',
      '2.0.0,1.1.0,1.0.0',
    ])
    expect(await store.listChunks({ ...ref, path: 'LICENSE.md' })).toEqual([])
    const repo = await store.listChunks({ ...ref, source: 'repository', version: '2.0.0' })
    expect(repo.map((chunk) => chunk.path)).toEqual([
      'docs/guide.md',
      'docs/migration.md',
      'llms.txt',
    ])
    expect(repo[0]?.url).toBe('https://github.com/acme/lib/blob/v2.0.0/docs/guide.md#guide')
    const releases = await store.listChunks({ ...ref, source: 'releases' })
    expect(
      Object.fromEntries(releases.map((chunk) => [chunk.path, chunk.versions.join(',')])),
    ).toEqual({
      'releases/v1.1.0': '1.1.0',
      'releases/v1.2.0': '2.0.0',
      'releases/v2.0.0': '2.0.0',
    })

    const calls = client.calls.length
    const again = await indexLibraries({ ...input, now: at(1) })
    expect(again.versionsAdded).toBe(0)
    expect(archives).toEqual(['2.0.0', '1.1.0', '1.0.0'])
    expect(client.calls.length).toBe(calls)
  })

  test('versions leave the matrix, wait out the grace period and go', async () => {
    const store = librariesOf()
    const artifacts = memoryArtifactStore()
    const { registry } = fakeRegistry()
    const base = { store, artifacts, registries: { npm: registry }, settings }
    await indexLibraries({ ...base, uses: uses(['lib', '1.0.0']), now: at(0) })
    await indexLibraries({ ...base, uses: uses(['lib', '2.0.0', 'gl:b']), now: at(1) })
    const left = await store.getVersion(ref, '1.0.0')
    expect(left?.roles).toEqual([])
    expect(left?.usedBy).toEqual([])
    expect(left?.leftAt).toBe(at(1)().toISOString())
    expect((await store.getVersion(ref, '2.0.0'))?.usedBy).toEqual(['gl:b'])

    const later = await indexLibraries({
      ...base,
      uses: uses(['lib', '2.0.0', 'gl:b']),
      now: at(30),
    })
    expect(later.versionsRemoved).toBe(2)
    expect((await store.listVersions(ref)).map((record) => record.version)).toEqual(['2.0.0'])
    expect(await store.listChunks({ ...ref, version: '1.0.0' })).toEqual([])

    const back = await indexLibraries({ ...base, uses: uses(['lib', '1.0.0']), now: at(31) })
    expect(back.versionsAdded).toBe(2)
    expect((await store.getVersion(ref, '1.0.0'))?.leftAt).toBeUndefined()

    await indexLibraries({ ...base, uses: [], now: at(40) })
    expect(await store.getLibrary(ref)).toBeDefined()
    expect((await store.listVersions(ref)).every((record) => record.leftAt)).toBe(true)
    const gone = await indexLibraries({ ...base, uses: [], now: at(80) })
    expect(gone.librariesRemoved).toBe(1)
    expect(await store.getLibrary(ref)).toBeUndefined()
  })

  test('failures stay with their source and are retried', async () => {
    const store = librariesOf()
    const artifacts = memoryArtifactStore()
    const failing = fakeRegistry({ failArchive: '1.1.0' })
    const base = { store, artifacts, settings, uses: uses(['lib', '1.0.0']) }
    const summary = await indexLibraries({
      ...base,
      registries: { npm: failing.registry },
      now: at(0),
    })
    expect(summary.failures).toEqual([
      { library: 'npm:lib', version: '1.1.0', source: 'archive', message: 'registry down' },
    ])
    const failed = await store.getVersion(ref, '1.1.0')
    expect(failed?.sources.archive?.status).toBe('failed')
    expect(failed?.sources.api?.status).toBe('failed')
    expect(failed?.sources.repository?.status).toBe('skipped')
    expect((await store.getVersion(ref, '1.0.0'))?.sources.archive?.status).toBe('ok')

    const healthy = fakeRegistry()
    await indexLibraries({ ...base, registries: { npm: healthy.registry }, now: at(1) })
    expect(healthy.archives).toEqual(['1.1.0'])
    expect((await store.getVersion(ref, '1.1.0'))?.sources.api?.status).toBe('ok')
  })

  test('artifacts dropped by retention are fetched again', async () => {
    const store = librariesOf()
    const artifacts = memoryArtifactStore()
    const { registry, archives } = fakeRegistry()
    const base = {
      store,
      artifacts,
      registries: { npm: registry },
      settings,
      uses: uses(['lib', '2.0.0']),
    }
    await indexLibraries({ ...base, now: at(0) })
    const id = (await store.getVersion(ref, '2.0.0'))?.api ?? ''
    await artifacts.delete(id)
    await indexLibraries({ ...base, now: at(1) })
    expect(archives).toEqual(['2.0.0', '2.0.0'])
    expect((await store.getVersion(ref, '2.0.0'))?.api).toBe(id)
    expect(await artifacts.has(id)).toBe(true)
  })

  test('hooks run when enabled, and include and exclude apply', async () => {
    const store = librariesOf()
    const artifacts = memoryArtifactStore()
    const { registry } = fakeRegistry()
    const seen: { name: string; oldest?: string }[] = []
    const site: SiteSource = async (library, version) => ({
      chunks: [
        {
          ...ref,
          id: `site-${version}`,
          source: 'site',
          path: '/docs',
          headings: ['Site'],
          text: `Site docs of ${library.name}`,
        },
      ],
      status: { status: 'ok', at: at(0)().toISOString() },
    })
    const summary = await indexLibraries({
      store,
      artifacts,
      registries: { npm: registry },
      uses: uses(['lib', '1.0.0'], ['@types/lib', '1.0.0']),
      settings: {
        ...settings,
        include: ['npm:@types/lib', 'lib'],
        exclude: ['@types/*', 'nothing'],
        sources: { repository: false, releases: false, issues: true, site: true },
      },
      issueIndexer: async (library: LibraryRecord, context) => {
        seen.push({
          name: library.name,
          ...(context.oldestUsedReleaseAt ? { oldest: context.oldestUsedReleaseAt } : {}),
        })
        if (library.name === '@types/lib') throw new Error('quota')
      },
      siteSource: site,
      now: at(0),
    })
    expect(seen).toEqual([
      { name: '@types/lib' },
      { name: 'lib', oldest: '2024-01-01T00:00:00.000Z' },
    ])
    expect(summary.failures.map((failure) => [failure.library, failure.source])).toEqual([
      ['npm:@types/lib', 'issues'],
    ])
    expect(
      (await store.getLibrary({ ecosystem: 'npm', name: '@types/lib' }))?.sources.issues?.status,
    ).toBe('failed')
    expect((await store.getLibrary(ref))?.sources.site?.status).toBe('ok')
    expect(
      (await store.listChunks({ ...ref, source: 'site' })).map((chunk) => chunk.versions),
    ).toEqual([['1.0.0'], ['2.0.0']])
  })

  test('Go module paths with a major suffix join one library', async () => {
    const store = librariesOf()
    const names: string[] = []
    const registry: LibraryRegistry = {
      async library(target) {
        names.push(target.name)
        return { ...target, versions: [{ version: 'v1.0.0' }, { version: 'v2.1.0' }] }
      },
      async archive() {
        return undefined
      },
    }
    await indexLibraries({
      store,
      artifacts: memoryArtifactStore(),
      registries: { Go: registry },
      uses: [
        { ecosystem: 'Go', name: 'github.com/acme/mod', version: 'v1.0.0', repo: 'gl:a' },
        { ecosystem: 'Go', name: 'github.com/acme/mod/v2', version: 'v2.1.0', repo: 'gl:b' },
      ],
      settings: {
        ...settings,
        sources: { repository: false, releases: false, issues: false, site: false },
      },
      now: at(0),
    })
    expect(names).toEqual(['github.com/acme/mod'])
    const versions = await store.listVersions({ ecosystem: 'Go', name: 'github.com/acme/mod' })
    expect(versions.map((record) => [record.version, record.usedBy])).toEqual([
      ['v2.1.0', ['gl:b']],
      ['v1.0.0', ['gl:a']],
    ])
    expect(versions[0]?.sources.archive?.status).toBe('missing')
  })

  test('aborts between libraries', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await indexLibraries({
      store: librariesOf(),
      artifacts: memoryArtifactStore(),
      registries: {},
      uses: uses(['lib', '1.0.0']),
      settings,
      signal: controller.signal,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
  })
})
