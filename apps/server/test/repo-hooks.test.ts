import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { repoHooks } from '../src/repo-hooks.ts'

const vault = aesVault('v'.repeat(32))
const at = '2026-10-31T12:00:00.000Z'
const repo = { forge: 'work', path: 'acme/widget' }

test('deliveries never restore a rotated token and none is lost when they overlap', async () => {
  const store = memoryStore()
  if (!store.kv) throw new Error('memory store has kv')
  const hooks = repoHooks(store.kv, vault)
  const first = await hooks.rotate(repo, at)
  await hooks.save(repo, {
    ...first.hook,
    registered: [{ hookId: '1', scope: 'project', target: repo.path, url: 'https://hk.test/a' }],
  })
  const delivery = { at, event: 'Push Hook', enqueued: 1, durationMs: 3 }

  const [second] = await Promise.all([
    hooks.rotate(repo, at),
    hooks.recordDelivery(repo, delivery),
    hooks.recordDelivery(repo, { ...delivery, event: 'Tag Push Hook' }),
  ])

  expect(await hooks.find(first.token)).toBeUndefined()
  expect(await hooks.find(second.token)).toEqual(repo)
  const current = await hooks.get(repo)
  if (!current) throw new Error('hook kept')
  expect(await hooks.token(current)).toBe(second.token)
  expect(current.registered).toHaveLength(1)
  expect((await hooks.deliveries(repo)).map((d) => d.event).toSorted()).toEqual([
    'Push Hook',
    'Tag Push Hook',
  ])

  await hooks.remove(repo)
  expect(await hooks.deliveries(repo)).toEqual([])
})
