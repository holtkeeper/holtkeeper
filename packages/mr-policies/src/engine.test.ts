import { describe, expect, test } from 'bun:test'

import type { GitForge } from '@holtkeeper/forge'
import { z } from 'zod'

import { diffFile, fakeForge, mrEvent, pipeline } from '../test/fake-forge.ts'
import { defineAction, createRegistry, builtinActions } from './actions/index.ts'
import { evaluatePolicies, orderPolicies } from './engine.ts'
import { createMemory } from './memory.ts'
import type { Policy } from './model.ts'

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({
  id,
  name: id,
  enabled: true,
  scope: { all: true },
  when: {},
  actions: [],
  ...extra,
})

describe('evaluatePolicies', () => {
  test('idempotent per head commit: approve and comment are not repeated', async () => {
    const memory = createMemory()
    const policies = [
      policy('p', { actions: [{ type: 'approve' }, { type: 'comment', body: 'ok' }] }),
    ]
    const first = fakeForge({ files: [diffFile('a')] })
    const run = (forge: GitForge, headSha: string) =>
      evaluatePolicies({ policies, event: mrEvent({ mr: { headSha } }), forge, memory })
    expect((await run(first.forge, 'sha1')).outcomes.map((o) => o.status)).toEqual(['done', 'done'])
    const again = await run(first.forge, 'sha1')
    expect(again.outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped'])
    expect(first.calls.length).toBe(2)
    const pushed = await run(fakeForge({ files: [diffFile('a')], headSha: 'sha2' }).forge, 'sha2')
    expect(pushed.outcomes.map((o) => o.status)).toEqual(['done', 'done'])
  })

  test('deferred, failed and dry-run actions are not remembered', async () => {
    const memory = createMemory()
    const policies = [policy('p', { actions: [{ type: 'approve', requirePipeline: 'success' }] })]
    const event = mrEvent({ mr: { headSha: 'sha1' } })
    const running = fakeForge({ pipelines: [pipeline('running')] })
    expect(
      (await evaluatePolicies({ policies, event, forge: running.forge, memory })).outcomes[0]
        ?.status,
    ).toBe('deferred')
    const green = fakeForge({ pipelines: [pipeline('success')] })
    expect(
      (await evaluatePolicies({ policies, event, forge: green.forge, memory, dryRun: true }))
        .outcomes[0]?.status,
    ).toBe('dry-run')
    expect(
      (await evaluatePolicies({ policies, event, forge: green.forge, memory })).outcomes[0]?.status,
    ).toBe('done')
  })

  test('collects skipAnalyzers and enqueue intents', async () => {
    const { forge } = fakeForge()
    const result = await evaluatePolicies({
      policies: [
        policy('a', {
          skipAnalyzers: ['review'],
          actions: [{ type: 'enqueue', analyzer: 'lint' }],
        }),
        policy('b', {
          skipAnalyzers: ['quality', 'review'],
          actions: [{ type: 'enqueue', analyzer: 'lint' }],
        }),
      ],
      event: mrEvent(),
      forge,
      memory: createMemory(),
    })
    expect(result.skipAnalyzers).toEqual(['review', 'quality'])
    expect(result.enqueue).toEqual([{ analyzer: 'lint' }])
    const all = await evaluatePolicies({
      policies: [policy('a', { skipAnalyzers: '*' }), policy('b', { skipAnalyzers: ['x'] })],
      event: mrEvent(),
      forge,
    })
    expect(all.skipAnalyzers).toBe('*')
  })

  test('unmatched policies contribute nothing', async () => {
    const { forge } = fakeForge()
    const result = await evaluatePolicies({
      policies: [
        policy('a', {
          when: { targetBranch: ['release'] },
          skipAnalyzers: '*',
          actions: [{ type: 'close' }],
        }),
      ],
      event: mrEvent(),
      forge,
    })
    expect(result).toEqual({
      matched: [],
      unmatched: [{ policyId: 'a', reason: 'target branch main does not match release' }],
      outcomes: [],
      skipAnalyzers: [],
      enqueue: [],
    })
  })

  test('most specific scope first, list order among equals, stop ends evaluation', async () => {
    const { forge } = fakeForge()
    const policies = [
      policy('global', { scope: { all: true } }),
      policy('group', { scope: { groups: ['games'] } }),
      policy('exact', { scope: { repos: ['games/app'] } }),
      policy('glob-1', { scope: { repos: ['games/*'] } }),
      policy('glob-2', { scope: { repos: ['games/**'] }, stop: true }),
      policy('elsewhere', { scope: { repos: ['tools/**'] } }),
      policy('off', { enabled: false }),
    ]
    expect(orderPolicies(policies, mrEvent()).map((p) => p.id)).toEqual([
      'exact',
      'glob-1',
      'glob-2',
      'group',
      'global',
    ])
    const result = await evaluatePolicies({ policies, event: mrEvent(), forge })
    expect(result.matched.map((m) => m.policyId)).toEqual(['exact', 'glob-1', 'glob-2'])
    expect(result.unmatched).toEqual([
      { policyId: 'off', reason: 'disabled' },
      { policyId: 'global', reason: 'an earlier policy stopped evaluation' },
      { policyId: 'group', reason: 'an earlier policy stopped evaluation' },
      { policyId: 'elsewhere', reason: 'scope does not cover the repository' },
    ])
  })

  test('policies are limited to their settings entry scope', async () => {
    const { forge, calls } = fakeForge({ files: [diffFile('a')] })
    const result = await evaluatePolicies({
      policies: [
        policy('p', {
          scope: { all: true },
          within: { repos: ['tools/**'] },
          actions: [{ type: 'approve' }],
        }),
      ],
      event: mrEvent(),
      forge,
    })
    expect(result.matched).toEqual([])
    expect(calls).toEqual([])
  })

  test('unknown actions, throwing conditions and throwing providers become outcomes', async () => {
    const { forge } = fakeForge()
    const broken = { ...forge, listPipelines: async () => Promise.reject(new Error('timeout')) }
    const boom = defineAction({
      type: 'boom',
      schema: z.object({ type: z.literal('boom') }),
      run: async () => Promise.reject(new Error('kaput')),
    })
    const result = await evaluatePolicies({
      policies: [
        policy('a', { when: { pipeline: ['success'] } }),
        policy('b', { actions: [{ type: 'nope' }, { type: 'boom' }] }),
      ],
      event: mrEvent({ mr: { headSha: 'sha1' } }),
      forge: broken,
      registry: createRegistry([...builtinActions, boom]),
    })
    expect(result.unmatched).toEqual([{ policyId: 'a', reason: 'error: timeout' }])
    expect(result.outcomes).toEqual([
      { policyId: 'b', action: 'nope', status: 'failed', detail: 'unknown action nope' },
      { policyId: 'b', action: 'boom', status: 'failed', detail: 'kaput' },
    ])
  })

  test('matched reasons explain the decision', async () => {
    const { forge } = fakeForge({ pipelines: [pipeline('success')] })
    const result = await evaluatePolicies({
      policies: [
        policy('release', { when: { sourceBranch: ['release/*'], pipeline: ['success'] } }),
      ],
      event: mrEvent({ mr: { sourceBranch: 'release/2.0', headSha: 'sha1' } }),
      forge,
    })
    expect(result.matched).toEqual([
      {
        policyId: 'release',
        reasons: ['source branch release/2.0 matches release/*', 'pipeline is success'],
      },
    ])
  })
})
