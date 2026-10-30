import { describe, expect, test } from 'bun:test'

import {
  actionVariants,
  cleanCondition,
  describeCondition,
  newAction,
  newPolicy,
  normalizePolicies,
  policyProblems,
  summarizePolicy,
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

test('describeCondition and summarizePolicy read like a sentence', () => {
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
  expect(
    summarizePolicy({
      id: 'p',
      name: 'P',
      enabled: true,
      when: { event: ['open', 'update'] },
      actions: [{ type: 'approve' }, { type: 'merge' }],
      skipAnalyzers: ['review'],
    }),
  ).toBe('If event is open or update → approve, merge, skip review')
  expect(summarizePolicy({ id: 'p', name: 'P', enabled: true, when: {}, actions: [] })).toBe(
    'Always → nothing',
  )
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
