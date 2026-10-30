import { describe, expect, test } from 'bun:test'

import { diffFile, fakeForge, mrEvent, pipeline } from '../../test/fake-forge.ts'
import { evaluatePolicies } from '../engine.ts'
import { createMemory } from '../memory.ts'
import type { MergeRequestEvent, Policy, PolicyAction } from '../model.ts'
import { renderTemplate } from './template.ts'

const policy = (actions: PolicyAction[], extra: Partial<Policy> = {}): Policy => ({
  id: 'p',
  name: 'Policy',
  enabled: true,
  scope: { groups: ['games'] },
  when: {},
  actions,
  ...extra,
})

async function run(
  actions: PolicyAction[],
  options: {
    event?: MergeRequestEvent
    forge?: Parameters<typeof fakeForge>[0]
    dryRun?: boolean
    botUser?: string
    fetch?: (url: string, init?: RequestInit) => Promise<Response>
  } = {},
) {
  const fake = fakeForge({ files: [diffFile('a.ts')], ...options.forge })
  const result = await evaluatePolicies({
    policies: [policy(actions)],
    event: options.event ?? mrEvent(),
    forge: fake.forge,
    memory: createMemory(),
    dryRun: options.dryRun,
    botUser: options.botUser,
    fetch: options.fetch,
    now: new Date('2026-10-30T00:00:00Z'),
  })
  return { ...fake, result, outcome: result.outcomes[0] }
}

describe('approve', () => {
  test('approves through submitReview with a rendered summary', async () => {
    const { calls, outcome } = await run([{ type: 'approve', summary: 'Release by {author}' }])
    expect(outcome).toMatchObject({
      policyId: 'p',
      action: 'approve',
      status: 'done',
      detail: 'approved',
    })
    expect(calls).toEqual([
      {
        method: 'submitReview',
        args: [
          'games/slots',
          7,
          {
            refs: { baseSha: 'base', startSha: 'start', headSha: 'sha1' },
            comments: [],
            summary: 'Release by alice',
            event: 'approve',
          },
        ],
      },
    ])
  })

  test('requirePipeline defers while running and skips when not green', async () => {
    const running = await run([{ type: 'approve', requirePipeline: 'success' }], {
      forge: { pipelines: [pipeline('running')] },
    })
    expect(running.outcome?.status).toBe('deferred')
    const failed = await run([{ type: 'approve', requirePipeline: 'success' }], {
      forge: { pipelines: [pipeline('failed')] },
    })
    expect(failed.outcome).toMatchObject({
      status: 'skipped',
      detail: 'pipeline is failed, approval needs success',
    })
    const green = await run([{ type: 'approve', requirePipeline: 'success' }], {
      forge: { pipelines: [pipeline('success')] },
    })
    expect(green.outcome?.status).toBe('done')
  })

  test('refuses to approve merge requests by the bot itself unless allowed', async () => {
    const event = mrEvent({ mr: { author: 'holtkeeper' } })
    const refused = await run([{ type: 'approve' }], { event, botUser: 'holtkeeper' })
    expect(refused.outcome?.status).toBe('skipped')
    expect(refused.calls).toEqual([])
    const allowed = await run([{ type: 'approve', allowSelfApprove: true }], {
      event,
      botUser: 'holtkeeper',
    })
    expect(allowed.outcome?.status).toBe('done')
  })

  test('is unsupported without submitReview', async () => {
    const { outcome } = await run([{ type: 'approve' }], { forge: { minimal: true } })
    expect(outcome?.status).toBe('unsupported')
  })
})

describe('merge', () => {
  test('merges when the pipeline succeeds by default', async () => {
    const { calls, outcome } = await run([
      { type: 'merge', squash: true, removeSourceBranch: true },
    ])
    expect(outcome?.status).toBe('done')
    expect(calls[0]?.args[2]).toEqual({
      squash: true,
      removeSourceBranch: true,
      whenPipelineSucceeds: true,
    })
  })

  test('skips drafts and closed merge requests, reports failures', async () => {
    expect(
      (await run([{ type: 'merge' }], { event: mrEvent({ mr: { draft: true } }) })).outcome?.status,
    ).toBe('skipped')
    expect(
      (await run([{ type: 'merge' }], { event: mrEvent({ mr: { state: 'closed' } }) })).outcome
        ?.detail,
    ).toBe('merge request is closed')
    const failed = await run([{ type: 'merge' }], { forge: { failMerge: true } })
    expect(failed.outcome).toMatchObject({
      status: 'failed',
      detail: 'set to merge when the pipeline succeeds failed: merge conflict',
    })
  })
})

describe('label', () => {
  test('adds and removes labels, skips when nothing changes', async () => {
    const event = mrEvent({ mr: { labels: ['docs', 'stale'] } })
    const { calls, outcome } = await run(
      [{ type: 'label', add: ['docs-only'], remove: ['stale'] }],
      { event },
    )
    expect(outcome).toMatchObject({ status: 'done', detail: 'added docs-only; removed stale' })
    expect(calls[0]?.args[2]).toEqual({ labels: ['docs', 'docs-only'] })
    const same = await run([{ type: 'label', add: ['docs'] }], { event })
    expect(same.outcome?.status).toBe('skipped')
  })

  test('later actions see labels set by earlier ones without changing the caller event', async () => {
    const event = mrEvent()
    const { outcomes } = (
      await run(
        [
          { type: 'label', add: ['x'] },
          { type: 'label', add: ['x'] },
        ],
        { event },
      )
    ).result
    expect(outcomes.map((o) => o.status)).toEqual(['done', 'skipped'])
    expect(event.mr.labels).toEqual([])
  })

  test('invalid options fail the action', async () => {
    const { outcome } = await run([{ type: 'label' }])
    expect(outcome?.status).toBe('failed')
    expect(outcome?.detail).toContain('label needs add or remove')
  })
})

describe('comment, close, draft', () => {
  test('comments with a template', async () => {
    const { calls, outcome } = await run([
      { type: 'comment', body: '{author}: {sourceBranch} → {targetBranch} ({title}) {unknown}' },
    ])
    expect(outcome?.status).toBe('done')
    expect(calls[0]?.args[2]).toBe('alice: feature/slots → main (feat: add slots) {unknown}')
  })

  test('closes open merge requests only', async () => {
    const { calls, outcome } = await run([{ type: 'close' }])
    expect(outcome?.status).toBe('done')
    expect(calls[0]?.args[2]).toEqual({ state: 'closed' })
    expect(
      (await run([{ type: 'close' }], { event: mrEvent({ mr: { state: 'merged' } }) })).outcome
        ?.status,
    ).toBe('skipped')
  })

  test('sets and unsets draft', async () => {
    const set = await run([{ type: 'draft' }])
    expect(set.calls[0]?.args[2]).toEqual({ draft: true })
    const unset = await run([{ type: 'draft', draft: false }], {
      event: mrEvent({ mr: { draft: true } }),
    })
    expect(unset.outcome?.detail).toBe('marked as ready')
    expect((await run([{ type: 'draft', draft: false }])).outcome?.status).toBe('skipped')
  })
})

describe('assignReviewers', () => {
  test('is unsupported unless the forge can assign reviewers', async () => {
    expect((await run([{ type: 'assignReviewers', reviewers: ['bob'] }])).outcome?.status).toBe(
      'unsupported',
    )
    const { calls, outcome } = await run(
      [{ type: 'assignReviewers', reviewers: ['alice', 'bob'] }],
      {
        forge: { reviewers: true },
      },
    )
    expect(outcome?.status).toBe('done')
    expect(calls[0]).toEqual({ method: 'assignReviewers', args: ['games/slots', 7, ['bob']] })
  })
})

describe('enqueue and webhook', () => {
  test('enqueue returns an intent and touches nothing', async () => {
    const { calls, outcome, result } = await run([
      { type: 'enqueue', analyzer: 'review', options: { depth: 'quick' } },
    ])
    expect(outcome?.status).toBe('intent')
    expect(result.enqueue).toEqual([{ analyzer: 'review', options: { depth: 'quick' } }])
    expect(calls).toEqual([])
  })

  test('webhook posts JSON with secret url and headers', async () => {
    process.env.MR_POLICY_HOOK = 'https://hooks.example.test/x'
    const requests: { url: string; init?: RequestInit }[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(null, { status: 204 })
    }
    const { outcome } = await run(
      [
        {
          type: 'webhook',
          url: { env: 'MR_POLICY_HOOK' },
          headers: { authorization: 'Bearer t' },
          payload: { team: 'games' },
        },
      ],
      { fetch },
    )
    expect(outcome).toMatchObject({ status: 'done', detail: 'posted to webhook' })
    expect(requests[0]?.url).toBe('https://hooks.example.test/x')
    const body = JSON.parse(requests[0]?.init?.body as string) as Record<string, unknown>
    expect(body).toMatchObject({
      policy: 'p',
      at: '2026-10-30T00:00:00.000Z',
      payload: { team: 'games' },
    })
    expect(JSON.stringify(outcome)).not.toContain('hooks.example.test')
    const failing = await run([{ type: 'webhook', url: 'https://x.test' }], {
      fetch: async () => new Response(null, { status: 500 }),
    })
    expect(failing.outcome?.detail).toBe('posted to webhook failed: webhook answered 500')
  })
})

describe('dry run', () => {
  test('reports what would happen without forge writes', async () => {
    const { calls, result } = await run(
      [
        { type: 'approve' },
        { type: 'merge' },
        { type: 'label', add: ['x'] },
        { type: 'comment', body: 'hi' },
      ],
      { dryRun: true },
    )
    expect(result.outcomes.map((o) => o.status)).toEqual([
      'dry-run',
      'dry-run',
      'dry-run',
      'dry-run',
    ])
    expect(result.outcomes[0]?.detail).toBe('would be approved')
    expect(calls).toEqual([])
  })
})

test('renderTemplate leaves unknown placeholders', () => {
  expect(renderTemplate('{id} in {repo} by {actor} {nope}', mrEvent())).toBe(
    '7 in games/slots by alice {nope}',
  )
})
