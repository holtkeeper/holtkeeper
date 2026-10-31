import { describe, expect, test } from 'bun:test'

import { fakeGitHub } from '../test/fixtures.ts'
import { tagCandidates, tagResolver, versionOfTag } from './tags.ts'

const repository = { host: 'github.com', path: 'acme/mono', url: 'https://github.com/acme/mono' }

test('candidates and versions of tags', () => {
  expect(tagCandidates('@acme/lib', '1.2.3')).toEqual([
    'v1.2.3',
    '1.2.3',
    '@acme/lib@1.2.3',
    '@acme/lib-v1.2.3',
    'lib@1.2.3',
    'lib-v1.2.3',
  ])
  expect(tagCandidates('github.com/acme/mono/sub', 'v1.0.0', 'sub')).toContain('sub/v1.0.0')
  expect(versionOfTag('@acme/lib@1.2.3', '@acme/lib')).toBe('1.2.3')
  expect(versionOfTag('v2.0.0-rc.1', '@acme/lib')).toBe('2.0.0-rc.1')
  expect(versionOfTag('other@1.0.0', '@acme/lib')).toBeUndefined()
  expect(versionOfTag('lib-v3.0.0', '@acme/lib')).toBe('3.0.0')
})

describe('tagResolver', () => {
  test('finds tags in the listing, once per repository', async () => {
    const github = fakeGitHub(
      {
        '/repos/acme/mono/tags?per_page=100': [{ name: 'lib@1.0.0', commit: { sha: 's1' } }],
        '/repos/acme/mono/tags?page=2': [{ name: 'v2.0.0', commit: { sha: 's2' } }],
      },
      {},
      { '/repos/acme/mono/tags?per_page=100': '/repos/acme/mono/tags?page=2' },
    )
    const resolve = tagResolver(github)
    expect(await resolve({ repository, name: '@acme/lib', version: '1.0.0' })).toEqual({
      tag: 'lib@1.0.0',
      commit: 's1',
      ref: 'lib@1.0.0',
    })
    expect(
      await resolve({ repository, name: '@acme/lib', version: '2.0.0', commit: 'head' }),
    ).toEqual({ tag: 'v2.0.0', commit: 'head', ref: 'v2.0.0' })
    expect(
      await resolve({ repository, name: '@acme/lib', version: '3.0.0', commit: 'c3' }),
    ).toEqual({
      commit: 'c3',
      ref: 'c3',
    })
    expect(await resolve({ repository, name: '@acme/lib', version: '4.0.0' })).toEqual({})
    expect(github.calls.filter((call) => call.includes('/tags'))).toHaveLength(2)
  })

  test('asks for each candidate when the listing was cut off', async () => {
    const github = fakeGitHub(
      {
        '/repos/acme/mono/tags?per_page=100': [],
        '/repos/acme/mono/git/ref/tags/%40acme/lib%401.0.0': {
          object: { sha: 'x', type: 'commit' },
        },
      },
      {},
      { '/repos/acme/mono/tags?per_page=100': '/repos/acme/mono/tags?page=2' },
    )
    const resolve = tagResolver(github, { maxPages: 1 })
    expect(await resolve({ repository, name: '@acme/lib', version: '1.0.0' })).toEqual({
      tag: '@acme/lib@1.0.0',
      commit: 'x',
      ref: '@acme/lib@1.0.0',
    })
  })

  test('other hosts keep only the registry commit', async () => {
    const resolve = tagResolver(fakeGitHub({}))
    expect(
      await resolve({
        repository: { host: 'gitlab.com', path: 'a/b', url: 'https://gitlab.com/a/b' },
        name: 'b',
        version: '1.0.0',
        commit: 'c',
      }),
    ).toEqual({ commit: 'c', ref: 'c' })
  })
})
