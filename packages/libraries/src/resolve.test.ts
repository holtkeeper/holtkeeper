import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { resolveLibrary } from './resolve.ts'

test('resolves Go major suffixes and package paths to the indexed module, npm names as given', async () => {
  const store = memoryStore().libraries!
  const at = '2026-11-13T12:00:00.000Z'
  await store.putLibrary({
    ecosystem: 'Go',
    name: 'example.com/acme/kit',
    sources: {},
    updatedAt: at,
  })
  await store.putLibrary({ ecosystem: 'npm', name: 'lodash.debounce', sources: {}, updatedAt: at })

  for (const name of [
    'example.com/acme/kit',
    'example.com/acme/kit/v3',
    'example.com/acme/kit/v3/draw/lines',
    'example.com/acme/kit/draw',
  ])
    expect((await resolveLibrary(store, { package: name })).library?.name).toBe(
      'example.com/acme/kit',
    )
  expect((await resolveLibrary(store, { package: 'lodash.debounce' })).library?.ecosystem).toBe(
    'npm',
  )
  expect(await resolveLibrary(store, { package: 'example.com/other/v2' })).toEqual({
    ref: { ecosystem: 'Go', name: 'example.com/other' },
  })
  expect(await resolveLibrary(store, { package: '@acme/ui', ecosystem: 'npm' })).toEqual({
    ref: { ecosystem: 'npm', name: '@acme/ui' },
  })
})
