import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal, RepoTarget } from '@holtkeeper/access'
import type { Store, User } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { createIdentities } from './service.ts'

const games: RepoTarget = { forge: 'work', path: 'games/app', groups: ['games'] }

const user = (id: string, overrides: Partial<User> = {}): User => ({
  id,
  name: id,
  grants: [{ scope: { groups: ['games'] }, actions: ['analyses:run'] }],
  disabled: false,
  sessionVersion: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
  ...overrides,
})

const asUser = (u: User): Principal => ({
  id: u.id,
  name: u.name,
  provider: 'users',
  grants: u.grants,
})

let store: Store
let clock: Date
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

const service = () =>
  createIdentities({
    accounts: store.externalAccounts ?? (undefined as never),
    users: store.users,
    audit: store.audit,
    now: () => clock,
  })

beforeEach(async () => {
  store = memoryStore()
  clock = new Date('2026-10-30T10:00:00.000Z')
  await store.users.putUser(user('alice'))
  await store.users.putUser(user('bob'))
})

describe('self-service links', () => {
  test('a linked account starts unverified and never authorizes', async () => {
    const identities = service()
    const alice = asUser(user('alice'))
    const account = await identities.link(alice, {
      provider: 'gitlab:work',
      externalId: '42',
      username: 'alice',
    })
    expect(account).toMatchObject({
      userId: 'alice',
      verification: 'unverified',
      linkedBy: 'alice',
    })
    expect(await identities.list(alice)).toEqual([account])
    expect(
      await identities.resolveExternalActor({ provider: 'gitlab:work', externalId: '42' }),
    ).toBeUndefined()
    expect(
      await identities.authorizeExternal({
        provider: 'gitlab:work',
        externalId: '42',
        action: 'analyses:run',
        repo: games,
      }),
    ).toEqual({ allowed: false, reason: 'unverified' })
    expect(await identities.link(alice, { provider: 'gitlab:work', externalId: '42' })).toEqual(
      account,
    )
  })

  test('rejects malformed input and non-numeric forge ids', async () => {
    const identities = service()
    const alice = asUser(user('alice'))
    expect(
      String(await failure(identities.link(alice, { provider: 'GitLab', externalId: '1' }))),
    ).toContain('provider')
    expect(
      String(
        await failure(identities.link(alice, { provider: 'gitlab:work', externalId: 'alice' })),
      ),
    ).toContain('numeric')
    expect(
      (await identities.link(alice, { provider: 'slack:T01', externalId: 'U123' })).provider,
    ).toBe('slack:T01')
  })

  test('challenge verification upgrades the link and then authorizes with current grants', async () => {
    const identities = service()
    const alice = asUser(user('alice'))
    const account = await identities.link(alice, { provider: 'gitlab:work', externalId: '42' })
    const issued = await identities.issueChallenge(alice, account.id)
    expect(issued.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(issued.command).toBe(`/holtkeeper verify ${issued.code}`)
    expect(issued.expiresAt).toBe('2026-10-30T10:30:00.000Z')
    expect((await store.externalAccounts?.get(account.id))?.challenge?.hash).not.toContain(
      issued.code,
    )

    expect(
      await identities.completeChallenge({
        provider: 'gitlab:work',
        externalId: '43',
        code: issued.code,
      }),
    ).toEqual({ ok: false, reason: 'not-linked' })
    expect(
      await identities.completeChallenge({
        provider: 'gitlab:work',
        externalId: '42',
        code: 'AAAA-AAAA',
      }),
    ).toEqual({ ok: false, reason: 'wrong-code' })

    const done = await identities.completeChallenge({
      provider: 'gitlab:work',
      externalId: '42',
      username: 'alice.gl',
      code: issued.code.toLowerCase().replace('-', ''),
    })
    expect(done).toMatchObject({
      ok: true,
      account: { verification: 'challenge', username: 'alice.gl', verifiedAt: clock.toISOString() },
    })
    expect((await store.externalAccounts?.get(account.id))?.challenge).toBeUndefined()

    const allowed = await identities.authorizeExternal({
      provider: 'gitlab:work',
      externalId: '42',
      action: 'analyses:run',
      repo: games,
    })
    expect(allowed).toMatchObject({ allowed: true, reason: 'allowed', principal: { id: 'alice' } })
    expect(
      await identities.authorizeExternal({
        provider: 'gitlab:work',
        externalId: '42',
        action: 'users:write',
        repo: games,
      }),
    ).toMatchObject({ allowed: false, reason: 'forbidden' })

    await store.users.putUser(user('alice', { disabled: true }))
    expect(
      await identities.resolveExternalActor({ provider: 'gitlab:work', externalId: '42' }),
    ).toBeUndefined()
    expect(
      (
        await identities.authorizeExternal({
          provider: 'gitlab:work',
          externalId: '42',
          action: 'analyses:run',
          repo: games,
        })
      ).reason,
    ).toBe('no-principal')

    expect(
      await identities.completeChallenge({
        provider: 'gitlab:work',
        externalId: '42',
        code: issued.code,
      }),
    ).toEqual({ ok: false, reason: 'already-verified' })
    expect(String(await failure(identities.issueChallenge(alice, account.id)))).toContain(
      'already verified',
    )

    const audit = await store.audit?.list({ action: 'account.verify' })
    expect(audit?.events.map((e) => e.outcome)).toEqual(['denied', 'ok', 'denied', 'denied'])
    expect(audit?.events[1]?.via).toBe('webhook')
  })

  test('challenges expire and lock after too many wrong codes', async () => {
    const identities = service()
    const alice = asUser(user('alice'))
    const account = await identities.link(alice, { provider: 'gitlab:work', externalId: '42' })
    const first = await identities.issueChallenge(alice, account.id)
    clock = new Date('2026-10-30T10:31:00.000Z')
    const answer = { provider: 'gitlab:work', externalId: '42', code: first.code }
    expect(await identities.completeChallenge(answer)).toEqual({ ok: false, reason: 'expired' })
    expect(await identities.completeChallenge(answer)).toEqual({
      ok: false,
      reason: 'no-challenge',
    })

    const second = await identities.issueChallenge(alice, account.id)
    for (let i = 0; i < 4; i++)
      expect((await identities.completeChallenge({ ...answer, code: 'ZZZZ-ZZZZ' })).ok).toBe(false)
    expect(await identities.completeChallenge({ ...answer, code: 'ZZZZ-ZZZZ' })).toEqual({
      ok: false,
      reason: 'too-many-attempts',
    })
    expect(await identities.completeChallenge({ ...answer, code: second.code })).toEqual({
      ok: false,
      reason: 'no-challenge',
    })
  })

  test('unverified claims can be taken over, verified ones cannot; unlink is own only', async () => {
    const identities = service()
    const alice = asUser(user('alice'))
    const bob = asUser(user('bob'))
    const squatted = await identities.link(bob, { provider: 'gitlab:work', externalId: '42' })
    const mine = await identities.link(alice, { provider: 'gitlab:work', externalId: '42' })
    expect(mine.userId).toBe('alice')
    expect(await store.externalAccounts?.get(squatted.id)).toBeUndefined()

    const { code } = await identities.issueChallenge(alice, mine.id)
    await identities.completeChallenge({ provider: 'gitlab:work', externalId: '42', code })
    expect(
      await failure(identities.link(bob, { provider: 'gitlab:work', externalId: '42' })),
    ).toMatchObject({ code: 'conflict' })
    expect(await failure(identities.unlink(bob, mine.id))).toMatchObject({ code: 'not-found' })
    await identities.unlink(alice, mine.id)
    expect(await identities.list(alice)).toEqual([])
  })

  test('principals without stored users resolve from their last snapshot', async () => {
    const identities = service()
    const jane: Principal = {
      id: 'jane',
      name: 'Jane',
      provider: 'header',
      grants: [{ scope: { groups: ['games'] }, actions: ['analyses:read'] }],
    }
    const account = await identities.link(jane, { provider: 'slack:T1', externalId: 'U1' })
    expect(account.principal).toEqual({ name: 'Jane', provider: 'header', grants: jane.grants })
    await store.externalAccounts?.put({ ...account, verification: 'admin' })

    const promoted: Principal = {
      ...jane,
      grants: [{ scope: { groups: ['games'] }, actions: ['analyses:run'] }],
    }
    await identities.list(promoted)
    expect(
      await identities.authorizeExternal({
        provider: 'slack:T1',
        externalId: 'U1',
        action: 'analyses:run',
        repo: games,
      }),
    ).toMatchObject({ allowed: true, principal: { id: 'jane', provider: 'header' } })
  })
})
