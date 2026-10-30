import { describe, expect, test } from 'bun:test'

import { can } from '@holtkeeper/access'

import { noAuth } from './index.ts'

describe('noAuth', () => {
  test('treats every request as root', async () => {
    const principal = await noAuth({ name: 'admin' }).authenticate(new Request('http://x'))
    expect(principal).toMatchObject({ id: 'root', name: 'admin', provider: 'none' })
    expect(principal && can(principal, 'users:write', { kind: 'global' })).toBe(true)
    expect(noAuth().info()).toEqual({ provider: 'none', methods: [] })
  })
})
