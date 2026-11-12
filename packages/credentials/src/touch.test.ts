import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createCredentialService } from './service.ts'

function setup() {
  let at = Date.parse('2026-10-30T12:00:00.000Z')
  const store = memoryStore()
  const touches: string[] = []
  const credentials = {
    ...store.credentials,
    touch: async (id: string, when: string) => {
      touches.push(`${id}@${when}`)
      await store.credentials.touch(id, when)
    },
  }
  const service = createCredentialService({
    credentials,
    vault: aesVault('a'.repeat(32)),
    now: () => new Date(at),
  })
  const advance = (ms: number) => {
    at += ms
  }
  return { service, touches, advance }
}

const input = {
  name: 'Widget bot',
  kind: 'gitlab',
  url: 'https://forge.example.test',
  scope: { all: true },
  secret: 'widget-secret',
}

test('reveal records a use at most once a minute per credential', async () => {
  const { service, touches, advance } = setup()
  const first = await service.create(input)
  const second = await service.create({ ...input, name: 'Gadget bot' })
  expect(first.lastUsedAt).toBeUndefined()

  expect(await service.reveal(first.id)).toBe('widget-secret')
  advance(30_000)
  await service.reveal(first.id)
  await service.reveal(second.id)
  expect(touches).toEqual([
    `${first.id}@2026-10-30T12:00:00.000Z`,
    `${second.id}@2026-10-30T12:00:30.000Z`,
  ])

  advance(30_000)
  await service.markUsed(first.id)
  expect(touches).toHaveLength(3)
  expect((await service.get(first.id))?.lastUsedAt).toBe('2026-10-30T12:01:00.000Z')
})

test('a failing touch never fails the use and unknown ids are ignored', async () => {
  const store = memoryStore()
  const service = createCredentialService({
    credentials: {
      ...store.credentials,
      touch: () => Promise.reject(new Error('database is down')),
    },
    vault: aesVault('a'.repeat(32)),
  })
  const created = await service.create(input)
  expect(await service.reveal(created.id)).toBe('widget-secret')
  await service.markUsed('missing')
})

test('updates keep lastUsedAt', async () => {
  const { service } = setup()
  const created = await service.create(input)
  await service.reveal(created.id)
  const updated = await service.update(created.id, { name: 'Renamed bot' })
  expect(updated.lastUsedAt).toBe('2026-10-30T12:00:00.000Z')
})

test('open returns the secret without recording a use', async () => {
  const { service, touches } = setup()
  const created = await service.create(input)
  expect(await service.open(created.id)).toBe('widget-secret')
  expect(touches).toEqual([])
})
