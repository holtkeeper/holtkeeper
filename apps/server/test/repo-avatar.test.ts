import { expect, test } from 'bun:test'

import { generatedRepoAvatar, repoInitials } from '../src/repo-avatar.ts'

test('initials come from the parent and the name', () => {
  expect(repoInitials('acme/data-tools/dealer-frontend')).toBe('DD')
  expect(repoInitials('acme/billing/frontend-libs')).toBe('BF')
  expect(repoInitials('game-frontend')).toBe('GF')
  expect(repoInitials('api')).toBe('AP')
})

test('generated avatars are stable per path and differ between siblings', () => {
  const a = generatedRepoAvatar({ forge: 'w', path: 'x/data-tools/dealer-frontend' })
  expect(a).toBe(generatedRepoAvatar({ forge: 'w', path: 'x/data-tools/dealer-frontend' }))
  expect(a).toStartWith('<svg')
  expect(a).toContain('>DD</text>')
  expect(a).not.toBe(generatedRepoAvatar({ forge: 'w', path: 'y/data-tools/dealer-frontend' }))
})
