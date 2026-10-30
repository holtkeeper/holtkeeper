import { describe, expect, test } from 'bun:test'

import { avatarOf, initialsOf, personOf } from './people.ts'

describe('people', () => {
  test('initials', () => {
    expect(initialsOf('Ann Lee Smith')).toBe('AL')
    expect(initialsOf('kriakiku')).toBe('K')
    expect(initialsOf('  ')).toBe('?')
  })

  test('activity ids resolve to people or fall back to the id', () => {
    const people = { u1: { name: 'Ann', avatarUrl: '/api/avatars/fox.svg' } }
    expect(personOf(people, 'u1')).toEqual({
      name: 'Ann',
      avatarUrl: '/api/avatars/fox.svg',
      known: true,
    })
    expect(personOf(people, 'work:games/a')).toEqual({
      name: 'work:games/a',
      avatarUrl: avatarOf('work:games/a'),
      known: false,
    })
    expect(avatarOf('a b')).toBe('/api/avatars/a%20b.svg')
  })
})
