import { describe, expect, test } from 'bun:test'

import { tarball } from '../../test/fixtures.ts'
import { normalizeRepository, npmRegistry } from './npm.ts'

describe('normalizeRepository', () => {
  test.each([
    ['github:acme/lib', 'github.com', 'acme/lib'],
    ['acme/lib', 'github.com', 'acme/lib'],
    ['gitlab:acme/lib', 'gitlab.com', 'acme/lib'],
    ['git+https://github.com/acme/lib.git', 'github.com', 'acme/lib'],
    ['git://github.com/acme/lib.git', 'github.com', 'acme/lib'],
    ['git+ssh://git@github.com/acme/lib.git', 'github.com', 'acme/lib'],
    ['git@github.com:acme/lib.git', 'github.com', 'acme/lib'],
    ['https://GitHub.com/acme/lib', 'github.com', 'acme/lib'],
  ])('%s', (input, host, path) => {
    expect(normalizeRepository(input)).toEqual({ host, path, url: `https://${host}/${path}` })
  })

  test('directories from the field and from tree URLs', () => {
    expect(
      normalizeRepository({
        type: 'git',
        url: 'https://github.com/acme/mono',
        directory: 'packages/a/',
      }),
    ).toEqual({
      host: 'github.com',
      path: 'acme/mono',
      directory: 'packages/a',
      url: 'https://github.com/acme/mono',
    })
    expect(
      normalizeRepository('https://github.com/acme/mono/tree/main/packages/b')?.directory,
    ).toBe('packages/b')
    expect(normalizeRepository('')).toBeUndefined()
    expect(normalizeRepository({})).toBeUndefined()
  })
})

describe('npmRegistry', () => {
  const packument = {
    name: '@acme/lib',
    description: 'A lib',
    'dist-tags': { latest: '2.0.0' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/acme/mono.git',
      directory: 'packages/lib',
    },
    homepage: 'https://lib.dev',
    time: { '1.0.0': '2024-01-01T00:00:00.000Z', '2.0.0': '2025-01-01T00:00:00.000Z' },
    versions: {
      '1.0.0': {
        deprecated: 'use 2',
        gitHead: 'abc',
        dist: { tarball: 'https://r/lib-1.0.0.tgz' },
      },
      '2.0.0': { dist: { tarball: 'https://r/lib-2.0.0.tgz' } },
    },
  }

  const fakeFetch = async (files: Record<string, Uint8Array>, requests: string[]) =>
    (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push(url)
      if (url === 'https://registry.example/@acme%2Flib') return Response.json(packument)
      const body = files[url]
      return body ? new Response(body) : new Response('no', { status: 404 })
    }) as typeof fetch

  test('reads versions, dates, deprecations, commits and the repository', async () => {
    const requests: string[] = []
    const registry = npmRegistry({
      fetch: await fakeFetch({}, requests),
      url: 'https://registry.example/',
    })
    const library = await registry.library({ ecosystem: 'npm', name: '@acme/lib' })
    expect(library).toEqual({
      ecosystem: 'npm',
      name: '@acme/lib',
      description: 'A lib',
      homepage: 'https://lib.dev',
      latest: '2.0.0',
      repository: {
        host: 'github.com',
        path: 'acme/mono',
        directory: 'packages/lib',
        url: 'https://github.com/acme/mono',
      },
      versions: [
        {
          version: '1.0.0',
          publishedAt: '2024-01-01T00:00:00.000Z',
          deprecated: 'use 2',
          commit: 'abc',
        },
        { version: '2.0.0', publishedAt: '2025-01-01T00:00:00.000Z' },
      ],
    })
    expect(await registry.library({ ecosystem: 'npm', name: 'missing' })).toBeUndefined()
    await registry.library({ ecosystem: 'npm', name: '@acme/lib' })
    expect(requests.filter((url) => url.endsWith('%2Flib'))).toHaveLength(1)
  })

  test('archive keeps docs, manifests and declarations without the top folder', async () => {
    const bytes = await tarball('package', {
      'package.json': '{"name":"@acme/lib"}',
      'README.md': '# Lib',
      'docs/guide.mdx': '# Guide',
      'dist/index.d.ts': 'export declare const a: number',
      'dist/index.js': 'export const a = 1',
      'logo.svg': '<svg/>',
      'big.md': 'x'.repeat(2_100_000),
    })
    const registry = npmRegistry({
      fetch: await fakeFetch({ 'https://r/lib-2.0.0.tgz': bytes }, []),
      url: 'https://registry.example',
    })
    const files = await registry.archive({ ecosystem: 'npm', name: '@acme/lib' }, '2.0.0')
    expect([...(files?.keys() ?? [])].toSorted()).toEqual([
      'README.md',
      'dist/index.d.ts',
      'docs/guide.mdx',
      'package.json',
    ])
    expect(await registry.archive({ ecosystem: 'npm', name: '@acme/lib' }, '9.9.9')).toBeUndefined()
    expect(await registry.archive({ ecosystem: 'npm', name: '@acme/lib' }, '1.0.0')).toBeUndefined()
  })
})
