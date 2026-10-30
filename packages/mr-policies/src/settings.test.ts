import { describe, expect, test } from 'bun:test'

import { policiesSchema } from './schema.ts'
import { combinePolicies, mergeRequestPoliciesSetting } from './settings.ts'

const repo = { forge: 'work', path: 'games/slots', groups: ['games'] }

describe('combinePolicies', () => {
  test('combines covering scopes most specific first; specific ids override', () => {
    const { policies, invalid } = combinePolicies(
      [
        {
          scope: { all: true },
          value: [
            { id: 'docs', name: 'Docs' },
            { id: 'global', name: 'Global' },
          ],
        },
        {
          scope: { groups: ['games'] },
          value: [{ id: 'docs', name: 'Games docs', enabled: false }],
        },
        {
          scope: { repos: ['games/slots'] },
          value: [{ id: 'own', name: 'Own', scope: { repos: ['games/**'] } }],
        },
        { scope: { repos: ['tools/**'] }, value: [{ id: 'tools', name: 'Tools' }] },
        { key: 'other.key', scope: { all: true }, value: 'x' },
        {
          scope: { groups: ['games'] },
          value: [{ id: 'bad', name: 'Bad', actions: [{ type: 'teleport' }] }],
        },
      ],
      repo,
    )
    expect(policies.map((p) => [p.id, p.name, p.enabled])).toEqual([
      ['own', 'Own', true],
      ['docs', 'Games docs', false],
      ['global', 'Global', true],
    ])
    expect(policies[0]?.scope).toEqual({ repos: ['games/**'] })
    expect(policies[0]?.within).toEqual({ repos: ['games/slots'] })
    expect(policies[1]?.scope).toEqual({ groups: ['games'] })
    expect(invalid).toHaveLength(1)
    expect(invalid[0]?.error).toContain('unknown action teleport')
  })

  test('newer entries win among equally specific scopes', () => {
    const { policies } = combinePolicies(
      [
        {
          scope: { groups: ['games'] },
          value: [{ id: 'p', name: 'Old' }],
          updatedAt: '2026-01-01',
        },
        {
          scope: { groups: ['games'] },
          value: [{ id: 'p', name: 'New' }],
          updatedAt: '2026-02-01',
        },
      ],
      repo,
    )
    expect(policies.map((p) => p.name)).toEqual(['New'])
  })
})

describe('policiesSchema', () => {
  test('applies defaults and validates actions', () => {
    expect(policiesSchema.parse([{ id: 'p', name: 'P' }])).toEqual([
      { id: 'p', name: 'P', enabled: true, when: {}, actions: [] },
    ])
    expect(
      policiesSchema.safeParse([
        { id: 'p', name: 'P', actions: [{ type: 'merge', squash: 'yes' }] },
      ]).success,
    ).toBe(false)
    expect(
      policiesSchema.safeParse([
        { id: 'p', name: 'P' },
        { id: 'p', name: 'Q' },
      ]).success,
    ).toBe(false)
  })

  test('the setting definition is structural', () => {
    expect(mergeRequestPoliciesSetting).toMatchObject({
      key: 'mergeRequests.policies',
      section: 'Merge requests',
    })
  })
})
