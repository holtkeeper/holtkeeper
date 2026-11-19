import { describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import { memoryStore } from '@holtkeeper/store/memory'

import { mcpTokens } from './tokens.ts'

const principal: Principal = { id: 'u1', name: 'Uma', provider: 'test', grants: [] }

const served = async (choices: Record<string, boolean>) => {
  const kv = memoryStore().kv
  if (!kv) throw new Error('no kv')
  const tokens = mcpTokens({ kv, now: () => new Date('2026-01-07T10:00:00Z') })
  const { secret } = await tokens.create(principal, { name: 'laptop', expiresInDays: 0 })
  const owned = (await kv.get('mcp:tokens:u1')) as { hash: string }[]
  const hash = owned[0]?.hash ?? ''
  const stored = (await kv.get(`mcp:token:${hash}`)) as Record<string, unknown>
  await kv.set(`mcp:token:${hash}`, { ...stored, toolsets: choices })
  await kv.set('mcp:tokens:u1', [{ ...owned[0], toolsets: choices }])
  const found = await tokens.authenticate(
    new Request('http://localhost/mcp', { headers: { authorization: `Bearer ${secret}` } }),
  )
  const [listed] = await tokens.list(principal)
  expect(listed?.toolsets).toEqual(found?.toolsets ?? [])
  return found?.toolsets ?? []
}

describe('mcpTokens toolsets', () => {
  test('a toolset turned off under its old name keeps the merged one off', async () => {
    expect(await served({})).toContain('packages')
    expect(await served({ catalog: false })).not.toContain('packages')
    expect(await served({ libraries: false })).not.toContain('packages')
    expect(await served({ catalog: true, libraries: true })).toContain('packages')
  })

  test('a choice for the merged toolset itself wins', async () => {
    expect(await served({ packages: true, catalog: false })).toContain('packages')
    expect(await served({ packages: false })).not.toContain('packages')
  })
})
