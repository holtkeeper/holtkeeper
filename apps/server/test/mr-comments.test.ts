import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig, parseConfigFile } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type GitForge, type MergeRequest, MergeRequestCommentsOffError } from '@holtkeeper/forge'
import { createLimiter } from '@holtkeeper/limits'
import { builtinSettings } from '@holtkeeper/settings'
import type { SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import { startManagedConfig } from '../src/managed.ts'
import { isReviewAnalyzer, reviewCancelReason } from '../src/mr-comments.ts'

const HEAD = 'c'.repeat(40)

let store: Store
let mr: MergeRequest & { headSha: string }
let posted: string[]

const forge = {
  kind: 'gitlab',
  getMergeRequest: async () => structuredClone(mr),
  updateMergeRequest: async (_repo: string, _id: number, input: { labels?: string[] }) => {
    if (input.labels) posted.push(`labels ${input.labels.join(',')}`)
    return mr
  },
  commentOnMergeRequest: async (_repo: string, _id: number, body: string) => {
    posted.push(`comment ${body}`)
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => forge } },
  groups: { shapes: { forge: 'work', include: ['shapes/*'] } },
  jobs: {
    webhookSecret: 'hook-secret',
    botUsernames: { work: 'holtkeeper' },
    onMergeRequest: { analyzers: ['review', 'lint'] },
  },
})

const analyzers = [
  { kind: 'review', scope: 'repo' as const, options: z.object({}).passthrough() },
  { kind: 'lint', scope: 'repo' as const, options: z.object({}).passthrough() },
]

const vault = aesVault('v'.repeat(32))

const app = () =>
  createApp({
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers,
    now: () => new Date('2026-11-01T12:00:00.000Z'),
  })

const setting = (id: string, key: string, scope: SettingEntry['scope'], value: unknown) =>
  store.settings.put({
    id,
    key,
    scope,
    value,
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

const commentsOff = (scope: SettingEntry['scope'], id = 'off') =>
  setting(id, 'mergeRequests.comments', scope, { enabled: false, reason: 'Team opted out' })

const hook = (path: string, event: string, body: Record<string, unknown>) =>
  app().request('/api/webhooks/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': 'hook-secret',
      'x-gitlab-event': event,
    },
    body: JSON.stringify({
      ...body,
      project: { path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
    }),
  })

const opened = (path: string) =>
  hook(path, 'Merge Request Hook', {
    object_kind: 'merge_request',
    user: { username: 'jane' },
    object_attributes: {
      iid: 7,
      title: mr.title,
      source_branch: 'feature/widget',
      target_branch: 'main',
      state: 'opened',
      action: 'open',
      last_commit: { id: HEAD },
    },
    labels: [],
  })

const command = (path: string, body: string) =>
  hook(path, 'Note Hook', {
    object_kind: 'note',
    user: { username: 'jane' },
    object_attributes: { id: 1, note: body, noteable_type: 'MergeRequest' },
    merge_request: { iid: 7, state: 'opened', last_commit: { id: HEAD } },
  })

const jobs = async () => (await store.jobs.list()).map((job) => job.analyzer).toSorted()

beforeEach(() => {
  store = memoryStore()
  posted = []
  mr = {
    id: 7,
    title: 'Add widget',
    description: '',
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    state: 'open',
    draft: false,
    labels: [],
    author: 'jane',
    webUrl: '',
    headSha: HEAD,
  }
})

describe('mergeRequests.comments', () => {
  test('off: the review is not queued, other analyzers are', async () => {
    await commentsOff({ groups: ['shapes'] })
    expect((await opened('shapes/widget')).status).toBe(202)
    expect(await jobs()).toEqual(['lint'])
  })

  test('a repository entry turns reviews back on inside a group that has them off', async () => {
    await commentsOff({ groups: ['shapes'] })
    await setting(
      'on',
      'mergeRequests.comments',
      { repos: ['shapes/widget-core'] },
      {
        enabled: true,
      },
    )
    await opened('shapes/widget-core')
    expect(await jobs()).toEqual(['lint', 'review'])
  })

  test('off: policy comment and label actions are skipped and logged as such', async () => {
    await commentsOff({ all: true })
    await setting('p', 'mergeRequests.policies', { all: true }, [
      {
        id: 'greet',
        name: 'Greet',
        when: {},
        actions: [
          { type: 'comment', body: 'Thanks!' },
          { type: 'label', add: ['seen'] },
        ],
      },
    ])
    await opened('shapes/widget')
    expect(posted).toEqual([])
    const skipped = (await store.audit.list()).events.filter(
      (event) => event.action === 'mr_policy.skipped',
    )
    expect(skipped.map((event) => event.details?.detail)).toEqual([
      'merge request comments are off',
      'merge request comments are off',
    ])
  })

  test('off: commands get no answer and queue no review', async () => {
    await commentsOff({ all: true })
    expect(await (await command('shapes/widget', '/holtkeeper help')).json()).toMatchObject({
      enqueued: [],
      ignored: 'merge request comments are off',
    })
    expect(posted).toEqual([])
    expect(await jobs()).toEqual([])
  })

  test('off: a manual review is refused', async () => {
    await commentsOff({ repos: ['shapes/widget'] })
    const response = await app().request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analyzer: 'review', repo: 'work:shapes/widget', options: {} }),
    })
    expect(response.status).toBe(409)
    expect(await jobs()).toEqual([])
  })

  test('a review queued before the setting was turned off is canceled at start', async () => {
    const cancel = reviewCancelReason(store, config)
    const repo = { forge: 'work', path: 'shapes/widget' }
    expect(await cancel({ analyzer: 'review', repo })).toBeUndefined()
    await commentsOff({ repos: ['shapes/widget'] })
    expect(await cancel({ analyzer: 'review', repo })).toBe(
      'merge request reviews are off: Team opted out',
    )
    expect(await cancel({ analyzer: 'lint', repo })).toBeUndefined()
  })

  test('the analyzer of the review command counts as a review', () => {
    const custom = parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => forge } },
      jobs: { commands: { review: { analyzer: 'deep-review' } } },
    })
    expect(isReviewAnalyzer(custom, 'deep-review')).toBe(true)
    expect(isReviewAnalyzer(custom, 'review')).toBe(true)
    expect(isReviewAnalyzer(custom, 'lint')).toBe(false)
  })

  test('managed forges refuse notes on merge requests whose comments are off', async () => {
    await commentsOff({ repos: ['shapes/widget'] })
    const service = createCredentialService({ credentials: store.credentials, vault })
    const credential = await service.create({
      name: 'work',
      kind: 'gitlab',
      url: 'https://gitlab.test',
      scope: { all: true },
      secret: 'tok',
    })
    await store.config?.put({
      type: 'forge',
      id: 'work',
      data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: credential.id },
      updatedAt: '2026-10-30T00:00:00.000Z',
    })
    const managed = await startManagedConfig({
      file: parseConfigFile({}, { warn: () => {} }),
      store,
      vault,
      credentials: service,
      limiter: createLimiter(),
      pollMs: 0,
    })
    const client = managed.source.current().forges.work?.create()
    expect(
      await client?.commentOnMergeRequest('shapes/widget', 1, 'hi').then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(MergeRequestCommentsOffError)
    managed.stop()
  })
})
