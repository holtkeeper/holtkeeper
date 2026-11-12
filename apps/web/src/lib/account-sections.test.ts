import { describe, expect, test } from 'bun:test'

import { parseAccountSection, visibleAccountSections } from './account-sections.ts'

describe('account sections', () => {
  test('only known sections parse', () => {
    expect(parseAccountSection('agents')).toBe('agents')
    expect(parseAccountSection('sign-in')).toBe('sign-in')
    expect(parseAccountSection('mcp')).toBeUndefined()
    expect(parseAccountSection(undefined)).toBeUndefined()
  })

  test('Sign-in is there only for the users provider', () => {
    expect(visibleAccountSections('users')).toContain('sign-in')
    expect(visibleAccountSections('header')).toEqual([
      'profile',
      'teams',
      'linked',
      'access',
      'agents',
      'preferences',
    ])
  })
})
