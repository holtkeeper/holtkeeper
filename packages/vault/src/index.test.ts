import { describe, expect, test } from 'bun:test'

import { aesVault } from './index.ts'

const key = 'k'.repeat(32)

describe('aesVault', () => {
  test('seals and opens values with fresh IVs', async () => {
    const vault = aesVault(key)
    const a = await vault.seal('glpat-secret')
    const b = await vault.seal('glpat-secret')
    expect(a).not.toBe(b)
    expect(a).not.toContain('glpat')
    expect(await vault.open(a)).toBe('glpat-secret')
  })

  test('fails with another key or tampered data', async () => {
    const sealed = await aesVault(key).seal('value')
    expect(aesVault('z'.repeat(32)).open(sealed)).rejects.toThrow()
    expect(aesVault(key).open(`${sealed.slice(0, -2)}AA`)).rejects.toThrow()
    expect(aesVault(key).open('plain')).rejects.toThrow('not a sealed value')
  })

  test('rejects short keys when first used', async () => {
    expect(aesVault('short').seal('x')).rejects.toThrow('at least 32')
  })
})
