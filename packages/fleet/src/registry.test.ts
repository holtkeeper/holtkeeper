import { expect, test } from 'bun:test'

import { createHttpRegistry, escapeModulePath } from './registry.ts'

test('asks npm and the Go proxy once per library', async () => {
  const calls: string[] = []
  const registry = createHttpRegistry({
    npmUrl: 'https://npm.test',
    goProxyUrl: 'https://go.test',
    fetch: async (url) => {
      calls.push(url)
      if (url === 'https://npm.test/@acme%2fui')
        return Response.json({ 'dist-tags': { latest: '3.1.0' } })
      if (url === 'https://go.test/github.com/!burnt!sushi/toml/@latest')
        return Response.json({ Version: 'v1.4.0' })
      return new Response('not found', { status: 404 })
    },
  })
  expect(await registry.latest('npm', '@acme/ui')).toBe('3.1.0')
  expect(await registry.latest('npm', '@acme/ui')).toBe('3.1.0')
  expect(await registry.latest('Go', 'github.com/BurntSushi/toml')).toBe('v1.4.0')
  expect(await registry.latest('npm', 'missing')).toBeUndefined()
  expect(calls).toHaveLength(3)
  expect(escapeModulePath('github.com/Azure/x')).toBe('github.com/!azure/x')
})

test('failed lookups resolve to undefined', async () => {
  const registry = createHttpRegistry({
    fetch: async () => {
      throw new Error('offline')
    },
  })
  expect(await registry.latest('npm', 'react')).toBeUndefined()
})
