import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { egressJobEnv, goPrivate, goPrivateJobEnv } from './go-private.ts'

test('narrows to the top-level namespaces the fleet includes', () => {
  expect(
    goPrivate(
      [{ id: 'work', kind: 'gitlab', url: 'https://gitlab.example' }],
      [
        { forge: 'work', include: ['shapes/**'] },
        { forge: 'work', include: ['shapes/round/*', 'widgets/core/*'] },
        { forge: 'other', include: ['ignored/*'] },
      ],
    ),
  ).toBe('gitlab.example/shapes,gitlab.example/widgets')
})

test('falls back to the whole host and keeps an instance sub-path', () => {
  expect(
    goPrivate(
      [
        { id: 'a', kind: 'gitlab', url: 'https://example.com/gitlab/' },
        { id: 'b', kind: 'gitlab', url: 'https://forge.example' },
      ],
      [
        { forge: 'b', include: ['shapes/*'] },
        { forge: 'b', include: ['*/libs/*'] },
      ],
    ),
  ).toBe('example.com/gitlab,forge.example')
})

test('leaves out forges the proxy adds no token for', () => {
  expect(
    goPrivate(
      [
        { id: 'a', kind: 'github', url: 'https://github.com' },
        { id: 'b', kind: 'gitlab', url: 'https://gitlab.example', packages: false },
        { id: 'c', kind: 'gitlab', url: 'not a url' },
      ],
      [],
    ),
  ).toBeUndefined()
})

test('reads panel forges and the fleet and teams of the panel and the config file', async () => {
  const store = memoryStore()
  const updatedAt = '2026-11-13T12:00:00.000Z'
  await store.config?.put({
    type: 'forge',
    id: 'work',
    updatedAt,
    data: { kind: 'gitlab', url: 'https://gitlab.example', credentialId: 'c1' },
  })
  await store.config?.put({
    type: 'team',
    id: 'shapes',
    updatedAt,
    data: { owns: ['work:shapes/**'], exclude: [], consumes: ['work:gizmos/core'], members: [] },
  })
  expect(
    await egressJobEnv(store, { fleet: { work: { include: ['widgets/*'], exclude: [] } } }),
  ).toEqual({
    GOPRIVATE: 'gitlab.example/gizmos,gitlab.example/shapes,gitlab.example/widgets',
  })
  expect(await egressJobEnv(memoryStore(), { teams: {}, fleet: {} })).toEqual({})
})

test('job GOPRIVATE joins the egress patterns, config-file forges, analyzed repositories and the setting', async () => {
  const store = memoryStore()
  const updatedAt = '2026-11-13T12:00:00.000Z'
  await store.config?.put({
    type: 'forge',
    id: 'saas',
    updatedAt,
    data: { kind: 'gitlab', url: 'https://gitlab.com', credentialId: 'c1' },
  })
  await store.config?.put({
    type: 'forge',
    id: 'hub',
    updatedAt,
    data: { kind: 'github', url: 'https://github.com', credentialId: 'c2' },
  })
  await store.analyses.add({
    repo: { forge: 'hub', path: 'acme-private/kit' },
    kind: 'depgraph',
    createdAt: updatedAt,
    data: {},
  })
  const env = await goPrivateJobEnv(
    store,
    {
      fleet: { saas: { include: ['shapes/*'], exclude: [] } },
      forges: { self: { url: 'https://git.example.com' } },
    },
    ['example.org/hidden', 'git.example.com/sub'],
  )
  expect(env).toEqual({
    GOPRIVATE: 'example.org/hidden,git.example.com,github.com/acme-private,gitlab.com/shapes',
  })
  expect(await goPrivateJobEnv(memoryStore(), { teams: {}, fleet: {} }, [])).toEqual({})
})
