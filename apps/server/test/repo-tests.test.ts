import { expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { memoryStore } from '@holtkeeper/store/memory'

import { repoTestsFor, testsExpectedFor } from '../src/repo-tests.ts'

const config = parseConfig({
  forges: { acme: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: { shapes: { forge: 'acme', include: ['shapes/*'] } },
})

test('reads repo.tests anew on every call, with the groups of the config', async () => {
  const store = memoryStore()
  const widget = { forge: 'acme', path: 'shapes/widget' }
  const core = { forge: 'acme', path: 'shapes/widget-core' }
  const expected = testsExpectedFor(store, () => config)
  expect(await expected(widget)).toBe(true)

  const put = (id: string, scope: Record<string, unknown>, value: unknown) =>
    store.settings.put({
      id,
      key: 'repo.tests',
      scope,
      value,
      secret: false,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
  await put('group', { groups: ['shapes'] }, { expected: false, reason: 'Config only' })
  await put('core', { repos: ['acme:shapes/widget-core'] }, { expected: true })
  expect(await expected(widget)).toBe(false)
  expect(await expected(core)).toBe(true)
  expect(await repoTestsFor(store, () => config)(widget)).toEqual({
    expected: false,
    reason: 'Config only',
  })
})
