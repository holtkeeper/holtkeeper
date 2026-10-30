import { describe, expect, test } from 'bun:test'

import { toCreateInput, toDraft, toUpdateInput, validateDraft } from './form.ts'

describe('credential form', () => {
  test('a new draft needs name and secret', () => {
    const draft = toDraft()
    expect(validateDraft(draft, true)).toEqual({
      name: 'Name is required',
      secret: 'Secret is required',
    })
    expect(validateDraft({ ...draft, name: 'x' }, false)).toEqual({})
  })

  test('validates url, scope and rotation days', () => {
    const draft = {
      ...toDraft(),
      name: 'x',
      secret: 's',
      url: 'nope',
      scope: { groups: [] },
      rotation: true,
      daysBefore: '90',
      lifetimeDays: '30',
    }
    expect(Object.keys(validateDraft(draft, true)).toSorted()).toEqual([
      'daysBefore',
      'scope',
      'url',
    ])
  })

  test('builds inputs', () => {
    const draft = {
      ...toDraft(),
      name: ' GitLab ',
      secret: 'glpat',
      expires: '2027-01-31',
      scope: { groups: ['g', 'g'] },
    }
    expect(toCreateInput(draft)).toEqual({
      name: 'GitLab',
      kind: 'gitlab',
      url: 'https://gitlab.com',
      scope: { groups: ['g'] },
      secret: 'glpat',
      expiresAt: '2027-01-31T00:00:00.000Z',
      rotation: { enabled: false, daysBefore: 14, lifetimeDays: 90 },
    })
    expect('secret' in toUpdateInput({ ...draft, secret: '' })).toBe(false)
  })
})
