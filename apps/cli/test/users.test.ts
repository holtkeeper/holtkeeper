import { expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import { memoryStore } from '@holtkeeper/store/memory'

import { UsageError } from '../src/audit.ts'
import { type UsersFlags, usersCommand } from '../src/users.ts'

const setup = (publicUrl?: string) => {
  const store = memoryStore()
  const config = {
    forges: {},
    groups: {},
    server: { auth: noAuth(), store, vaultKey: 'v'.repeat(32), ...(publicUrl && { publicUrl }) },
  } as unknown as HoltkeeperConfig
  const run = async (args: string[], flags: UsersFlags = {}) => {
    const out: string[] = []
    await usersCommand(config, args, flags, (line) => out.push(line))
    return out
  }
  return { store, run }
}

test('adds an admin and issues a login link that expires in 15 minutes', async () => {
  const { store, run } = setup('https://keeper.example.com/')
  const [added = ''] = await run(['add', 'Claude'], { admin: true, email: 'claude@example.com' })
  expect(added.split('\t').slice(1)).toEqual(['Claude', 'claude@example.com', 'admin', 'enabled'])
  const [user] = await store.users.listUsers()
  expect(user?.grants).toEqual([{ scope: { all: true }, actions: ['*'] }])

  const [link = ''] = await run(['login-link', 'claude@example.com'], { json: true })
  const issued = JSON.parse(link) as { link: string; expiresAt: string }
  expect(issued.link).toMatch(
    /^https:\/\/keeper\.example\.com\/auth\/users\/link\/[\w-]{43}\/login$/,
  )
  expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000)
  const [enroll = ''] = await run(['enroll-link', 'Claude'], { ttl: '2h' })
  expect(enroll).toMatch(/^https:\/\/keeper\.example\.com\/link\/[\w-]{43}$/)
  expect((await store.activity.list()).map((entry) => entry.action).toSorted()).toEqual([
    'user.invited',
    'user.link_issued',
    'user.link_issued',
  ])
})

test('refuses what it cannot do', async () => {
  const { run } = setup()
  await run(['add', 'Ann'], { email: 'ann@example.com' })
  const refused = (args: string[], flags?: UsersFlags) =>
    run(args, flags).then(
      () => undefined,
      (error: unknown) => (error instanceof UsageError ? error.message : error),
    )
  expect(await refused(['add', 'Ann 2'], { email: 'ann@example.com' })).toContain('already in use')
  expect(await refused(['login-link', 'Ann'])).toBe('users login-link needs server.publicUrl')
  expect(await refused(['remove', 'Ann'])).toContain('users expects list, add')
  expect(await run(['list'])).toHaveLength(1)
})
