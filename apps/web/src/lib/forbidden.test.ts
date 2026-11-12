import { describe, expect, test } from 'bun:test'

import { accessRequest, forbiddenTitle, relatedActions } from './forbidden.ts'

describe('forbidden', () => {
  test('the title names the missing action', () => {
    expect(forbiddenTitle({ action: 'releases:run', target: 'acme:acme/widgets' })).toBe(
      "You can't run release steps",
    )
    expect(forbiddenTitle(undefined)).toBe('No access')
  })

  test('related actions are the ones held on the same kind of object', () => {
    const grants = [
      {
        scope: { groups: ['widgets'] },
        actions: ['releases:read' as const, 'repos:read' as const],
      },
      { scope: { repos: ['acme/gadgets'] }, actions: ['releases:run' as const] },
    ]
    expect(relatedActions(grants, 'releases:run')).toEqual(['releases:read', 'releases:run'])
    expect(relatedActions(grants, 'audits:run')).toEqual([])
    expect(relatedActions([{ scope: { all: true }, actions: ['*'] }], 'users:write')).toEqual([
      'users:read',
      'users:invite',
      'users:write',
    ])
  })

  test('the request names the viewer, the permission, the target and the page', () => {
    expect(
      accessRequest({
        missing: { action: 'releases:run', target: 'acme:acme/widgets' },
        name: 'Ada',
        id: 'u-1',
        page: 'https://holtkeeper.example/releases',
      }),
    ).toBe(
      'Hi, could you give me permission to run release steps (releases:run) on acme:acme/widgets in Holtkeeper? I am Ada (u-1). Page: https://holtkeeper.example/releases',
    )
    expect(accessRequest({ missing: undefined, name: 'Ada', id: 'u-1', page: '/x' })).toContain(
      'access to this page',
    )
  })
})
