import { describe, expect, test } from 'bun:test'

import type { Grant, Principal } from '@holtkeeper/access'
import type { User } from '@holtkeeper/store'

import { canManageUser, canSeeUser, isGlobalAdmin } from './admin.ts'

const principal = (grants: Grant[]): Principal => ({
  id: 'p',
  name: 'P',
  provider: 'users',
  grants,
})
const user = (grants: Grant[]): User => ({
  id: 'u',
  name: 'U',
  grants,
  disabled: false,
  sessionVersion: 1,
  createdAt: '2026-10-29T00:00:00.000Z',
})

const games = (actions: Grant['actions']): Grant => ({ scope: { repos: ['games/**'] }, actions })

describe('admin permissions', () => {
  test('global admins see and manage everyone', () => {
    const root = principal([{ scope: { all: true }, actions: ['*'] }])
    expect(isGlobalAdmin(root)).toBe(true)
    expect(canManageUser(root, user([{ scope: { all: true }, actions: ['*'] }]))).toBe(true)
  })

  test('scoped admins only reach users within their grants', () => {
    const lead = principal([games(['users:read', 'users:write', 'repos:read'])])
    expect(isGlobalAdmin(lead)).toBe(false)
    expect(
      canSeeUser(lead, user([{ scope: { repos: ['games/app/**'] }, actions: ['repos:read'] }])),
    ).toBe(true)
    expect(canSeeUser(lead, user([{ scope: { all: true }, actions: ['repos:read'] }]))).toBe(false)
    expect(canManageUser(lead, user([games(['audits:run'])]))).toBe(false)
  })

  test('reading and writing need their own actions', () => {
    const reader = principal([games(['users:read', 'repos:read'])])
    const target = user([games(['repos:read'])])
    expect(canSeeUser(reader, target)).toBe(true)
    expect(canManageUser(reader, target)).toBe(false)
    expect(canSeeUser(principal([games(['repos:read'])]), target)).toBe(false)
  })
})
