import { expect, test } from 'bun:test'

import { createHttpRegistry, resolveTargets } from './registry.ts'

const fakeFetch = () => {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return Response.json({ Version: 'v1.4.0' })
  }
  return { fetch, calls }
}

test('never asks the Go module proxy about private modules', async () => {
  const { fetch, calls } = fakeFetch()
  const registry = createHttpRegistry({
    fetch,
    goProxyUrl: 'https://proxy.test',
    isPrivateGo: async (path) => path.startsWith('gitlab.example/'),
  })
  expect(await registry.latest('Go', 'gitlab.example/shapes/geom')).toBeUndefined()
  expect(await registry.latest('Go', 'example.com/acme/kit')).toBe('v1.4.0')
  expect(calls).toEqual(['https://proxy.test/example.com/acme/kit/@latest'])
  expect(
    resolveTargets(
      [{ name: 'gitlab.example/shapes/geom', ecosystem: 'Go', version: 'latest' }],
      registry,
    ),
  ).rejects.toThrow('private Go modules are never looked up')
  expect(
    await resolveTargets(
      [{ name: 'gitlab.example/shapes/geom', ecosystem: 'Go', version: '1.2.0' }],
      registry,
    ),
  ).toEqual([
    { name: 'gitlab.example/shapes/geom', ecosystem: 'Go', requested: '1.2.0', version: 'v1.2.0' },
  ])
})
