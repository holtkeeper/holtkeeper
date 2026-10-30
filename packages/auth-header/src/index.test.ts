import { describe, expect, test } from 'bun:test'

import { headerAuth } from './index.ts'

const request = (headers: Record<string, string>) => new Request('http://x', { headers })

describe('headerAuth', () => {
  const provider = headerAuth({
    proxySecret: { header: 'x-proxy-secret', value: 's3cret' },
    roles: {
      'keeper-admins': [{ scope: { all: true }, actions: ['*'] }],
      'games-team': [{ scope: { groups: ['games'] }, actions: ['audits:read', 'audits:run'] }],
    },
    defaultGrants: [{ scope: { all: true }, actions: ['repos:read'] }],
  })

  test('builds a principal from headers and maps groups to grants', async () => {
    const principal = await provider.authenticate(
      request({
        'x-proxy-secret': 's3cret',
        'x-forwarded-user': 'jane',
        'x-forwarded-email': 'jane@example.com',
        'x-forwarded-groups': 'games-team, unknown',
      }),
    )
    expect(principal).toEqual({
      id: 'header:jane',
      name: 'jane',
      email: 'jane@example.com',
      provider: 'header',
      grants: [
        { scope: { all: true }, actions: ['repos:read'] },
        { scope: { groups: ['games'] }, actions: ['audits:read', 'audits:run'] },
      ],
    })
  })

  test('ignores requests without the proxy secret or user', async () => {
    expect(await provider.authenticate(request({ 'x-forwarded-user': 'jane' }))).toBeUndefined()
    expect(
      await provider.authenticate(
        request({ 'x-proxy-secret': 'wrong', 'x-forwarded-user': 'jane' }),
      ),
    ).toBeUndefined()
    expect(await provider.authenticate(request({ 'x-proxy-secret': 's3cret' }))).toBeUndefined()
  })

  test('supports custom headers and a grants function', async () => {
    const custom = headerAuth({
      userHeader: 'remote-user',
      nameHeader: 'remote-name',
      groupsHeader: 'remote-groups',
      groupsSeparator: '|',
      grants: (identity) => [{ scope: { groups: identity.groups }, actions: ['audits:read'] }],
    })
    const principal = await custom.authenticate(
      request({ 'remote-user': 'u1', 'remote-name': 'Jane', 'remote-groups': 'a|b' }),
    )
    expect(principal).toMatchObject({ name: 'Jane', grants: [{ scope: { groups: ['a', 'b'] } }] })
  })
})
