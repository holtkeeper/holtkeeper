import { describe, expect, test } from 'bun:test'

import {
  actionVariants,
  cleanCondition,
  describeCondition,
  newAction,
  newPolicy,
  normalizePolicies,
  policiesEntryFor,
  policyProblems,
  withPolicy,
  withoutPolicy,
} from './policies.ts'

describe('normalizePolicies', () => {
  test('turns single values into lists and keeps a policy scope', () => {
    const [policy] = normalizePolicies([
      {
        id: 'bots',
        name: 'Bots',
        scope: { groups: ['web'] },
        when: {
          event: 'open',
          author: 'renovate-bot',
          labels: { any: 'deps' },
          any: [{ targetBranch: 'main' }],
          not: { draft: true },
        },
        actions: [{ type: 'approve' }, 'junk'],
        skipAnalyzers: '*',
      },
    ])
    expect(policy).toEqual({
      id: 'bots',
      name: 'Bots',
      enabled: true,
      scope: { groups: ['web'] },
      when: {
        event: ['open'],
        author: { users: ['renovate-bot'] },
        labels: { any: ['deps'] },
        any: [{ targetBranch: ['main'] }],
        not: { draft: true },
      },
      actions: [{ type: 'approve' }],
      skipAnalyzers: '*',
    })
  })

  test('drops what is not a list of policies', () => {
    expect(normalizePolicies(null)).toEqual([])
    expect(normalizePolicies([1, 'x'])).toEqual([])
  })
})

test('cleanCondition drops empty lists, blank titles and empty groups', () => {
  expect(
    cleanCondition({
      event: [],
      targetBranch: ['main'],
      title: ' ',
      author: { users: [] },
      labels: { any: [], none: ['wip'] },
      changedPaths: { all: [] },
      any: [],
      all: [{ draft: false }],
      not: { pipeline: [] },
    }),
  ).toEqual({
    targetBranch: ['main'],
    labels: { none: ['wip'] },
    all: [{ draft: false }],
  })
})

test('describeCondition reads like a sentence', () => {
  expect(
    describeCondition({
      targetBranch: ['main'],
      author: { users: ['renovate-bot', 'dependabot'], bot: true },
      any: [{ labels: { any: ['deps'] } }, { size: { maxLines: 50 } }],
      not: { draft: true },
    }),
  ).toEqual([
    'target is main',
    'author is renovate-bot or dependabot (bot)',
    '(labels include deps or at most 50 lines)',
    'not (is a draft)',
  ])
})

test('policyProblems reports bad and repeated ids, missing names and empty label actions', () => {
  const problems = policyProblems([
    { id: 'a', name: 'A', enabled: true, when: {}, actions: [{ type: 'label' }] },
    { id: 'a', name: ' ', enabled: true, when: {}, actions: [] },
    { id: 'bad id', name: 'C', enabled: true, when: {}, actions: [] },
    { id: 'ok', name: 'D', enabled: true, when: {}, actions: [{ type: 'label', add: ['x'] }] },
  ])
  expect([...problems]).toEqual([
    [0, ['A label action needs labels to add or remove']],
    [1, ['Id a is used twice', 'Give the policy a name']],
    [2, ['Id may use letters, digits, dots, dashes and underscores']],
  ])
})

test('newPolicy picks a free id', () => {
  expect(newPolicy(['policy-2']).id).toBe('policy-3')
  expect(newPolicy(['policy-1', 'policy-2']).id).toBe('policy-3')
})

describe('actionVariants', () => {
  const schema = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  type: { type: 'string', const: 'merge' },
                  whenPipelineSucceeds: { type: 'boolean', default: true },
                },
                required: ['type'],
              },
              { $ref: '#/$defs/close' },
            ],
          },
        },
      },
    },
    $defs: {
      close: { type: 'object', properties: { type: { const: 'close' } }, required: ['type'] },
    },
  }

  test('finds every action by its type constant, through refs', () => {
    expect([...actionVariants(schema).keys()]).toEqual(['merge', 'close'])
  })

  test('newAction starts from the variant initial value', () => {
    expect(newAction('merge', actionVariants(schema).get('merge'), schema)).toEqual({
      type: 'merge',
    })
    expect(newAction('custom', undefined, schema)).toEqual({ type: 'custom' })
  })
})

describe('saving one policy of an entry', () => {
  const stored = [
    { id: 'a', name: 'A', when: { targetBranch: 'main' }, actions: [{ type: 'approve' }] },
    { id: 'b', name: 'B', when: {}, actions: [] },
  ]

  test('replaces in place, renames by previous id, appends new ones and removes', () => {
    const renamed = withPolicy(stored, { ...newPolicy([]), id: 'c', name: 'C' }, 'a')
    expect(renamed.map((p) => p.id)).toEqual(['c', 'b'])
    expect(withPolicy(stored, { ...newPolicy(['a', 'b']), name: 'New' }).map((p) => p.id)).toEqual([
      'a',
      'b',
      'policy-3',
    ])
    expect(
      withPolicy(stored, { ...newPolicy([]), id: 'a', name: 'A', when: { title: ' ' } })[0]?.when,
    ).toEqual({})
    expect(withoutPolicy(stored, 'a').map((p) => p.id)).toEqual(['b'])
  })

  test('a new policy of a team goes to the entry scoped to exactly that group', () => {
    const entries = [
      { id: '1', key: 'mergeRequests.policies', scope: { groups: ['toys', 'games'] } },
      { id: '2', key: 'mergeRequests.policies', scope: { groups: ['toys'] } },
      { id: '3', key: 'mergeRequests.policies', scope: { all: true } },
      { id: '4', key: 'other', scope: { groups: ['games'] } },
    ]
    expect(policiesEntryFor(entries, 'mergeRequests.policies', 'toys')?.id).toBe('2')
    expect(policiesEntryFor(entries, 'mergeRequests.policies', undefined)?.id).toBe('3')
    expect(policiesEntryFor(entries, 'mergeRequests.policies', 'games')).toBeUndefined()
  })
})
