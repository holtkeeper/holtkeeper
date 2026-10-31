import { describe, expect, test } from 'bun:test'

import { strToU8, zipSync } from 'fflate'

import { goRegistry, keepModuleFile, moduleDeprecation } from './go.ts'

const fakeFetch = (routes: Record<string, string | Uint8Array>) => {
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const body = routes[url]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const proxy = 'https://proxy.test'

describe('goRegistry.library', () => {
  test('joins majors, drops pseudo-versions and reads deprecation from the newest go.mod', async () => {
    const withV2 = fakeFetch({
      [`${proxy}/github.com/!acme/lib/@v/list`]:
        'v1.0.0\nv1.1.0\nv0.0.0-20200101000000-abcdefabcdef\nv2.0.0+incompatible\n',
      [`${proxy}/github.com/!acme/lib/@latest`]: JSON.stringify({ Version: 'v1.1.0' }),
      [`${proxy}/github.com/!acme/lib/@v/v1.0.0.info`]: JSON.stringify({
        Time: '2020-01-01T00:00:00Z',
      }),
      [`${proxy}/github.com/!acme/lib/@v/v2.0.0+incompatible.mod`]:
        '// Deprecated: use github.com/Acme/lib/v2 instead.\nmodule github.com/Acme/lib\n',
      [`${proxy}/github.com/!acme/lib/v2/@v/list`]: 'v2.0.0\nv2.1.0-rc.1\n',
      [`${proxy}/github.com/!acme/lib/v2/@latest`]: JSON.stringify({ Version: 'v2.0.1' }),
      [`${proxy}/github.com/!acme/lib/v2/@v/v2.0.1.mod`]: 'module github.com/Acme/lib/v2\n',
    })
    const lib = await goRegistry({ fetch: withV2.fetch, proxyUrl: proxy }).library({
      ecosystem: 'Go',
      name: 'github.com/Acme/lib',
    })
    expect(lib?.versions.map((v) => v.version)).toEqual([
      'v1.0.0',
      'v1.1.0',
      'v2.0.0',
      'v2.0.0+incompatible',
      'v2.0.1',
      'v2.1.0-rc.1',
    ])
    expect(lib?.versions[0]).toEqual({
      version: 'v1.0.0',
      publishedAt: '2020-01-01T00:00:00Z',
      deprecated: 'use github.com/Acme/lib/v2 instead.',
    })
    expect(lib?.versions.find((v) => v.version === 'v2.0.1')?.deprecated).toBeUndefined()
    expect(lib?.latest).toBe('v2.0.1')
    expect(lib?.homepage).toBe('https://pkg.go.dev/github.com/Acme/lib')
    expect(lib?.repository).toEqual({
      host: 'github.com',
      path: 'Acme/lib',
      url: 'https://github.com/Acme/lib',
    })
    expect(withV2.calls).toContain(`${proxy}/github.com/!acme/lib/v3/@v/list`)
  })

  test('maps a sub-module of a GitHub repository to its directory', async () => {
    const { fetch } = fakeFetch({
      [`${proxy}/github.com/acme/mono/tools/@v/list`]: 'v0.1.0\n',
    })
    const lib = await goRegistry({ fetch, proxyUrl: proxy }).library({
      ecosystem: 'Go',
      name: 'github.com/acme/mono/tools',
    })
    expect(lib?.repository).toEqual({
      host: 'github.com',
      path: 'acme/mono',
      directory: 'tools',
      url: 'https://github.com/acme/mono',
    })
    expect(lib?.latest).toBe('v0.1.0')
  })

  test('resolves vanity paths through go-source, else go-import', async () => {
    const { fetch } = fakeFetch({
      [`${proxy}/golang.org/x/net/@v/list`]: 'v0.30.0\n',
      'https://golang.org/x/net?go-get=1': `<html><head>
        <meta name="go-import" content="golang.org/x/net git https://go.googlesource.com/net">
        <meta name="go-source" content="golang.org/x/net https://github.com/golang/net/ https://github.com/golang/net/tree/master{/dir} x">
        </head></html>`,
      [`${proxy}/k8s.io/client-go/@v/list`]: 'v0.31.0\n',
      'https://k8s.io/client-go?go-get=1':
        '<meta name="go-import" content="k8s.io/client-go git https://github.com/kubernetes/client-go">',
      [`${proxy}/example.org/mod/sub/@v/list`]: 'v1.0.0\n',
      'https://example.org/mod/sub?go-get=1':
        '<meta name="go-import" content="example.org/mod git https://git.example.org/team/mod.git">',
    })
    const registry = goRegistry({ fetch, proxyUrl: proxy })
    expect(
      (await registry.library({ ecosystem: 'Go', name: 'golang.org/x/net' }))?.repository,
    ).toEqual({ host: 'github.com', path: 'golang/net', url: 'https://github.com/golang/net' })
    expect(
      (await registry.library({ ecosystem: 'Go', name: 'k8s.io/client-go' }))?.repository,
    ).toEqual({
      host: 'github.com',
      path: 'kubernetes/client-go',
      url: 'https://github.com/kubernetes/client-go',
    })
    expect(
      (await registry.library({ ecosystem: 'Go', name: 'example.org/mod/sub' }))?.repository,
    ).toEqual({
      host: 'git.example.org',
      path: 'team/mod',
      directory: 'sub',
      url: 'https://git.example.org/team/mod',
    })
  })

  test('unknown modules are undefined', async () => {
    const { fetch } = fakeFetch({})
    expect(
      await goRegistry({ fetch, proxyUrl: proxy }).library({ ecosystem: 'Go', name: 'x.test/a' }),
    ).toBeUndefined()
  })
})

describe('goRegistry.archive', () => {
  test('unzips the module zip of the right major and keeps docs and API sources', async () => {
    const big = new Uint8Array(1_000_001)
    const zip = zipSync({
      'github.com/acme/lib/v2@v2.0.0/README.md': strToU8('# lib'),
      'github.com/acme/lib/v2@v2.0.0/go.mod': strToU8('module github.com/acme/lib/v2'),
      'github.com/acme/lib/v2@v2.0.0/lib.go': strToU8('package lib'),
      'github.com/acme/lib/v2@v2.0.0/lib_test.go': strToU8('package lib'),
      'github.com/acme/lib/v2@v2.0.0/sub/doc.go': strToU8('package sub'),
      'github.com/acme/lib/v2@v2.0.0/vendor/x/x.go': strToU8('package x'),
      'github.com/acme/lib/v2@v2.0.0/testdata/a.md': strToU8('x'),
      'github.com/acme/lib/v2@v2.0.0/big.go': big,
      'github.com/acme/lib/v2@v2.0.0/logo.png': strToU8('png'),
    })
    const { fetch, calls } = fakeFetch({
      [`${proxy}/github.com/acme/lib/v2/@v/v2.0.0.zip`]: zip,
    })
    const files = await goRegistry({ fetch, proxyUrl: proxy }).archive(
      { ecosystem: 'Go', name: 'github.com/acme/lib' },
      'v2.0.0',
    )
    expect(calls).toEqual([`${proxy}/github.com/acme/lib/v2/@v/v2.0.0.zip`])
    expect([...(files?.keys() ?? [])].toSorted()).toEqual([
      'README.md',
      'go.mod',
      'lib.go',
      'sub/doc.go',
    ])
    expect(new TextDecoder().decode(files?.get('README.md'))).toBe('# lib')
  })

  test('+incompatible versions come from the base path; missing zips are undefined', async () => {
    const { fetch, calls } = fakeFetch({})
    const files = await goRegistry({ fetch, proxyUrl: proxy }).archive(
      { ecosystem: 'Go', name: 'github.com/acme/lib' },
      'v3.0.0+incompatible',
    )
    expect(files).toBeUndefined()
    expect(calls).toEqual([`${proxy}/github.com/acme/lib/@v/v3.0.0+incompatible.zip`])
  })
})

describe('helpers', () => {
  test('keepModuleFile', () => {
    expect(keepModuleFile('docs/guide.md')).toBe(true)
    expect(keepModuleFile('LICENSE.txt')).toBe(true)
    expect(keepModuleFile('a/b.go')).toBe(true)
    expect(keepModuleFile('a/b_test.go')).toBe(false)
    expect(keepModuleFile('a/vendor/b.go')).toBe(false)
    expect(keepModuleFile('main.c')).toBe(false)
  })

  test('moduleDeprecation', () => {
    expect(moduleDeprecation('module x // Deprecated: gone\n')).toBe('gone')
    expect(
      moduleDeprecation(
        '// Package x does things.\n//\n// Deprecated: use y\n// instead.\nmodule x\n',
      ),
    ).toBe('use y instead.')
    expect(moduleDeprecation('// Some comment\nmodule x\n')).toBeUndefined()
    expect(moduleDeprecation('go 1.22\n')).toBeUndefined()
  })
})
