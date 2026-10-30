import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, MergeRequest, PipelineStatus, ReviewSubmission } from '@holtkeeper/forge'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import { mergeRequestAction } from '../src/events.ts'

const HEAD = 'c'.repeat(40)

let store: Store
let mr: MergeRequest & { headSha: string }
let pipeline: PipelineStatus
let labelUpdates: string[][]
let reviews: ReviewSubmission[]

const forge = {
  kind: 'gitlab',
  getMergeRequest: async () => structuredClone(mr),
  getMergeRequestDiff: async () => ({
    refs: { baseSha: 'b', startSha: 's', headSha: mr.headSha },
    files: [],
  }),
  updateMergeRequest: async (_repo: string, _id: number, input: { labels?: string[] }) => {
    if (input.labels) {
      labelUpdates.push(input.labels)
      mr.labels = input.labels
    }
    return mr
  },
  listPipelines: async () => [{ id: 1, ref: 'x', sha: mr.headSha, status: pipeline, webUrl: '' }],
  submitReview: async (_repo: string, _id: number, review: ReviewSubmission) => {
    reviews.push(review)
    return { posted: 0, failed: [] }
  },
  commentOnMergeRequest: async () => {},
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => forge } },
  groups: { games: { forge: 'work', include: ['games/*'] } },
  jobs: {
    webhookSecret: 'hook-secret',
    botUsername: 'holtkeeper',
    onMergeRequest: { analyzers: ['review', 'quality'] },
  },
})

const analyzers = [
  { kind: 'review', scope: 'repo' as const, options: z.object({}).passthrough() },
  { kind: 'quality', scope: 'repo' as const, options: z.object({}).passthrough() },
  { kind: 'port', scope: 'repo' as const, options: z.object({}).passthrough() },
]

const policies = [
  {
    id: 'release-approve',
    name: 'Approve releases',
    when: { sourceBranch: 'release/*' },
    actions: [{ type: 'approve', requirePipeline: 'success' }],
    skipAnalyzers: '*',
    stop: true,
  },
  {
    id: 'docs',
    name: 'Docs',
    when: { event: ['open'], title: '/docs/i' },
    actions: [
      { type: 'label', add: ['docs-only'] },
      { type: 'enqueue', analyzer: 'port', options: { targets: 'web' } },
    ],
    skipAnalyzers: ['review'],
  },
]

const app = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const hook = (event: string, body: unknown) =>
  app().request('/api/webhooks/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': 'hook-secret',
      'x-gitlab-event': event,
    },
    body: JSON.stringify(body),
  })

const project = { path_with_namespace: 'games/a', web_url: 'https://gitlab.test/games/a' }

const mergeRequestHook = (action: string) => ({
  object_kind: 'merge_request',
  user: { username: 'jane' },
  project,
  object_attributes: {
    iid: 7,
    title: mr.title,
    source_branch: mr.sourceBranch,
    target_branch: 'main',
    state: 'opened',
    action,
    last_commit: { id: HEAD },
  },
  labels: [],
})

const pipelineHook = (status: string, sha = HEAD) => ({
  object_kind: 'pipeline',
  user: { username: 'ci' },
  project,
  object_attributes: { id: 9, status, sha },
  merge_request: { iid: 7 },
})

const jobs = async () =>
  (await store.jobs.list()).map((j) => `${j.analyzer} ${JSON.stringify(j.options)}`).toSorted()

beforeEach(async () => {
  store = memoryStore()
  labelUpdates = []
  reviews = []
  pipeline = 'running'
  mr = {
    id: 7,
    title: 'Update docs',
    description: '',
    sourceBranch: 'feature/docs',
    targetBranch: 'main',
    state: 'open',
    draft: false,
    labels: [],
    author: 'jane',
    webUrl: '',
    headSha: HEAD,
  }
  await store.settings.put({
    id: 'p1',
    key: 'mergeRequests.policies',
    scope: { all: true },
    value: policies,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
})

describe('merge request policies in webhooks', () => {
  test('mergeRequestAction', () => {
    expect(mergeRequestAction('open', false, [])).toBe('open')
    expect(mergeRequestAction('update', true, [])).toBe('update')
    expect(mergeRequestAction('update', false, ['x'])).toBe('label')
    expect(mergeRequestAction('update', false, [])).toBeUndefined()
    expect(mergeRequestAction('approved', false, [])).toBe('approve')
    expect(mergeRequestAction('close', false, [])).toBeUndefined()
  })

  test('actions run, outcomes are logged, analyzers are skipped and intents queued', async () => {
    const response = await hook('Merge Request Hook', mergeRequestHook('open'))
    expect(response.status).toBe(202)
    expect(labelUpdates).toEqual([['docs-only']])
    expect(await jobs()).toEqual([
      'port {"targets":"web","mergeRequest":7}',
      'quality {"mergeRequest":7}',
    ])
    const events = (await store.activity.list()).map(
      (e) => `${e.action} ${JSON.stringify(e.details?.policy ?? '')}`,
    )
    expect(events).toContain('mr_policy.done "docs"')
    expect(events).toContain('mr_policy.intent "docs"')
  })

  test('a green pipeline on the head fires a deferred approval once', async () => {
    mr.sourceBranch = 'release/1.2'
    mr.title = 'Release 1.2'
    expect(await (await hook('Merge Request Hook', mergeRequestHook('open'))).json()).toEqual({
      enqueued: [],
      ignored: 'policies skipped every analyzer',
    })
    expect(reviews).toEqual([])
    expect((await store.activity.list()).map((e) => e.action)).toContain('mr_policy.deferred')

    expect(await (await hook('Pipeline Hook', pipelineHook('running'))).json()).toMatchObject({
      ignored: 'pipeline is running',
    })
    expect(
      await (await hook('Pipeline Hook', pipelineHook('success', 'd'.repeat(40)))).json(),
    ).toMatchObject({
      ignored: 'pipeline is not for the merge request head',
    })
    pipeline = 'success'
    await hook('Pipeline Hook', pipelineHook('success'))
    expect(reviews.map((r) => r.event)).toEqual(['approve'])
    await hook('Pipeline Hook', pipelineHook('success'))
    expect(reviews).toHaveLength(1)
    expect(
      await store.kv?.get(
        `policy:mr-policy:work:games/a!7@${HEAD}:release-approve:{"type":"approve","requirePipeline":"success"}`,
      ),
    ).toBe(true)
  })

  test('without policies nothing is loaded from the forge', async () => {
    await store.settings.remove('p1')
    await hook('Merge Request Hook', mergeRequestHook('open'))
    expect(labelUpdates).toEqual([])
    expect(await jobs()).toEqual(['quality {"mergeRequest":7}', 'review {"mergeRequest":7}'])
    expect(await (await hook('Pipeline Hook', pipelineHook('success'))).json()).toMatchObject({
      ignored: 'no policies apply',
    })
  })
})
