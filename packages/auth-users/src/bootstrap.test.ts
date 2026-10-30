import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { bootstrapUsers } from './bootstrap.ts'
import { hashToken } from './tokens.ts'

const now = () => new Date('2026-10-29T12:00:00.000Z')

test('creates a root admin with a hashed enrollment link', async () => {
  const { users } = memoryStore()
  const issued = await bootstrapUsers({
    store: users,
    origin: 'https://k.example',
    name: 'Root',
    now,
  })
  expect(issued?.expiresAt).toBe('2026-11-01T12:00:00.000Z')
  const token = issued?.link.split('/link/')[1] ?? ''
  const stored = await users.getLinkToken(hashToken(token))
  expect(stored?.purpose).toBe('enroll')
  expect(stored?.usedAt).toBeUndefined()
  expect(await users.getLinkToken(token)).toBeUndefined()
})

test('reissues while the bootstrap admin has no passkey, then stops', async () => {
  const { users } = memoryStore()
  await bootstrapUsers({ store: users, origin: 'https://k.example', name: 'Root', now })
  expect(
    await bootstrapUsers({ store: users, origin: 'https://k.example', name: 'Root', now }),
  ).toBeDefined()
  expect(await users.listUsers()).toHaveLength(1)
  const [root] = await users.listUsers()
  await users.putPasskey({
    id: 'k',
    userId: root?.id ?? '',
    publicKey: 'AA',
    counter: 0,
    createdAt: now().toISOString(),
  })
  expect(
    await bootstrapUsers({ store: users, origin: 'https://k.example', name: 'Root', now }),
  ).toBeUndefined()
})
