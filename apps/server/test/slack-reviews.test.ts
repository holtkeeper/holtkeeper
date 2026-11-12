import { beforeEach, describe, expect, test } from 'bun:test'

import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { GitForge, MergeRequest } from '@holtkeeper/forge'
import { type ReviewData, reviewMetrics } from '@holtkeeper/review'
import { builtinSettings } from '@holtkeeper/settings'
import type { Job, SettingEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { ServerDeps } from '../src/context.ts'
import { noteReviewJob } from '../src/mr-status.ts'
import { slackMessageOf } from '../src/routes/slack-events.ts'
import type { SlackApi, SlackPoster } from '../src/slack/client.ts'
import { createSlackReviews } from '../src/slack/service.ts'
import { slackSignature } from '../src/slack/signature.ts'

const NOW = new Date('2026-11-03T09:00:00.000Z')
const HEAD = 'c'.repeat(40)
const NEXT = 'd'.repeat(40)
const SECRET = 'shape-secret'
const BOUND = 'C0123WIDGET'
const OTHER = 'C0456OTHER'

let titleLookups: string[]
let titleFailing: boolean

const forge = {
  kind: 'gitlab',
  getMergeRequest: async (path: string, iid: number) => {
    titleLookups.push(`${path}!${iid}`)
    if (titleFailing) throw new Error('forge is down')
    return structuredClone(mr)
  },
} as unknown as GitForge

const config = parseConfig({
  forges: { acme: { kind: 'gitlab', url: 'https://git.acme.test', create: () => forge } },
  groups: {
    shapes: { forge: 'acme', include: ['shapes/*'] },
    tools: { forge: 'acme', include: ['tools/*'] },
    labs: { forge: 'acme', include: ['Labs/*'] },
  },
  jobs: { webhookSecret: 'hook-secret', onMergeRequest: { analyzers: ['review'] } },
})

const analyzers = [{ kind: 'review', scope: 'repo' as const, options: z.object({}).passthrough() }]
const vault = aesVault('v'.repeat(32))
const widget = { forge: 'acme', path: 'shapes/widget' }

let store: Store
let deps: ServerDeps
let app: ReturnType<typeof createApp>
let mr: MergeRequest & { headSha: string }
let reactions: string[]
let background: Promise<unknown>[]
let failing: { add?: string; remove?: string }
let slowMs: number
let posts: { channel: string; threadTs?: string; text: string; ts: string }[]
let updates: { channel: string; ts: string; text: string }[]
let postFailing: { post?: string; update?: string }
let logs: string[]
let workspaceEmoji: Set<string>
let attempts: string[]

const fakeSlack: SlackApi = {
  addReaction: async ({ channel, ts, name }) => {
    if (slowMs) await Bun.sleep(slowMs)
    attempts.push(name)
    if (failing.add) return { ok: false, error: failing.add }
    if (name.startsWith('hk-') && !workspaceEmoji.has(name))
      return { ok: false, error: 'invalid_name' }
    reactions.push(`+${name} ${channel}/${ts}`)
    return { ok: true }
  },
  removeReaction: async ({ channel, ts, name }) => {
    if (slowMs) await Bun.sleep(slowMs)
    if (failing.remove) return { ok: false, error: failing.remove }
    reactions.push(`-${name} ${channel}/${ts}`)
    return { ok: true }
  },
}

let postCount = 0

const fakePoster: SlackPoster = {
  post: async ({ channel, threadTs, text }) => {
    if (slowMs) await Bun.sleep(slowMs)
    if (postFailing.post) return { ok: false, error: postFailing.post }
    postCount++
    const ts = `1700000100.${String(postCount).padStart(6, '0')}`
    posts.push({ channel, ...(threadTs !== undefined && { threadTs }), text, ts })
    return { ok: true, channel, ts }
  },
  update: async ({ channel, ts, text }) => {
    if (slowMs) await Bun.sleep(slowMs)
    if (postFailing.update) return { ok: false, error: postFailing.update }
    updates.push({ channel, ts, text })
    return { ok: true, channel, ts }
  },
}

/** The emoji on each message after every reaction call so far. */
const shownOn = () => {
  const shown = new Map<string, Set<string>>()
  for (const entry of reactions) {
    const [change, target = ''] = entry.split(' ')
    const names = shown.get(target) ?? new Set<string>()
    if (change?.startsWith('+')) names.add(change.slice(1))
    else names.delete(change?.slice(1) ?? '')
    shown.set(target, names)
  }
  return Object.fromEntries([...shown].map(([target, names]) => [target, [...names]]))
}

const settle = async () => {
  while (background.length > 0) await Promise.all(background.splice(0))
}

const setting = (id: string, key: string, scope: SettingEntry['scope'], value: unknown) =>
  store.settings.put({ id, key, scope, value, secret: false, updatedAt: '2026-10-01T00:00:00Z' })

const bind = (channels: string[], scope: SettingEntry['scope'] = { groups: ['shapes'] }) =>
  setting(`slack-${JSON.stringify(scope)}`, 'slack.reviews', scope, { channels })

const connect = async (emoji?: Record<string, string>) => {
  await store.kv?.set('chat:slack:connection', {
    botToken: await vault.seal('xoxb-widget'),
    signingSecret: await vault.seal(SECRET),
    connectedAt: NOW.toISOString(),
    connectedBy: 'header:jane',
    ...(emoji && { emoji }),
  })
}

const signedPost = (body: string, headers: Record<string, string> = {}, secret = SECRET) => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  return app.request('/api/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': slackSignature(secret, timestamp, body),
      ...headers,
    },
    body,
  })
}

let eventCount = 0

const message = async (
  text: string,
  options: {
    channel?: string
    ts?: string
    event?: Record<string, unknown>
    eventId?: string
  } = {},
) => {
  eventCount++
  const response = await signedPost(
    JSON.stringify({
      type: 'event_callback',
      event_id: options.eventId ?? `Ev${eventCount}`,
      event: {
        type: 'message',
        channel: options.channel ?? BOUND,
        channel_type: 'channel',
        user: 'U0123ALEX',
        text,
        ts: options.ts ?? '1700000000.000100',
        ...options.event,
      },
    }),
  )
  expect(response.status).toBe(200)
  await settle()
}

const link = (path = 'shapes/widget', iid = 7) =>
  `<https://git.acme.test/${path}/-/merge_requests/${iid}|${path}!${iid}>`

const review = (overrides: Partial<ReviewData> = {}): ReviewData => ({
  mergeRequest: {
    id: 7,
    title: 'Add widget',
    webUrl: 'https://git.acme.test/shapes/widget/-/merge_requests/7',
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    author: 'alex',
  },
  head: HEAD,
  mode: 'full',
  verdict: 'looks-good',
  summary: 'Fine.',
  comments: [],
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 4,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  ...overrides,
})

const majorFinding = {
  id: 'f1',
  path: 'src/widget.ts',
  line: 3,
  severity: 'major' as const,
  category: 'bug' as const,
  title: 'Off by one',
  body: 'The loop skips the last item.',
  source: 'agent' as const,
  posted: true,
}

const storeReview = (data: ReviewData, createdAt = NOW.toISOString()) =>
  store.analyses.add({
    repo: widget,
    kind: 'review',
    ref: `!${data.mergeRequest.id}`,
    createdAt,
    data,
    metrics: reviewMetrics(data),
  })

const queueReview = async (head = HEAD, iid = 7) => {
  const job = await store.jobs.enqueue({
    analyzer: 'review',
    repo: widget,
    ref: head,
    options: { mergeRequest: iid },
    trigger: 'webhook',
    createdAt: NOW.toISOString(),
  })
  noteReviewJob(deps, job)
  await settle()
  return job
}

const finishReview = async (job: Job, data: ReviewData) => {
  const claimed = await store.jobs.claim('worker-1', NOW.toISOString())
  expect(claimed?.id).toBe(job.id)
  const record = await storeReview(data, new Date(NOW.getTime() + 60_000).toISOString())
  const done = await store.jobs.complete(job.id, { at: NOW.toISOString(), analysisId: record.id })
  if (done) noteReviewJob(deps, done)
  await settle()
}

const pushed = () =>
  app.request('/api/webhooks/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': 'hook-secret',
      'x-gitlab-event': 'Merge Request Hook',
    },
    body: JSON.stringify({
      object_kind: 'merge_request',
      user: { username: 'alex' },
      project: {
        path_with_namespace: 'shapes/widget',
        web_url: 'https://git.acme.test/shapes/widget',
      },
      object_attributes: {
        iid: 7,
        title: mr.title,
        source_branch: 'feature/widget',
        target_branch: 'main',
        state: 'opened',
        action: 'update',
        oldrev: HEAD,
        last_commit: { id: NEXT },
      },
      labels: [],
    }),
  })

beforeEach(async () => {
  store = memoryStore()
  reactions = []
  background = []
  failing = {}
  slowMs = 0
  posts = []
  updates = []
  postFailing = {}
  postCount = 0
  logs = []
  workspaceEmoji = new Set()
  attempts = []
  titleLookups = []
  titleFailing = false
  mr = {
    id: 7,
    title: 'Add widget',
    description: '',
    sourceBranch: 'feature/widget',
    targetBranch: 'main',
    state: 'open',
    draft: false,
    labels: [],
    author: 'alex',
    webUrl: '',
    headSha: NEXT,
  }
  deps = {
    config,
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    analyzers,
    slackApi: () => fakeSlack,
    slackPoster: () => fakePoster,
    onBackground: (work) => background.push(work),
    now: () => NOW,
  }
  const slack = createSlackReviews(deps, { log: (line) => logs.push(line) })
  deps.slackReviews = slack
  deps.mergeRequestStatus = slack
  app = createApp(deps)
  await connect()
  await bind([BOUND])
})

describe('slack events endpoint', () => {
  test('answers url_verification when signed', async () => {
    const response = await signedPost(
      JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge: 'abc' })
  })

  test('refuses bad and stale signatures, and answers 404 without a credential', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    expect((await signedPost(body, {}, 'other-secret')).status).toBe(401)
    const stale = String(Math.floor(NOW.getTime() / 1000) - 600)
    expect(
      (
        await signedPost(body, {
          'x-slack-request-timestamp': stale,
          'x-slack-signature': slackSignature(SECRET, stale, body),
        })
      ).status,
    ).toBe(401)
    expect((await signedPost(body, { 'x-slack-signature': '' })).status).toBe(401)
    await store.kv?.delete('chat:slack:connection')
    expect((await signedPost(body)).status).toBe(404)
  })

  test('refuses a body over 1 MB', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x'.repeat(1_100_000) })
    expect((await signedPost(body)).status).toBe(413)
  })

  test('messages without merge request links do not use up their event id', async () => {
    await storeReview(review())
    await message('no links here', { eventId: 'EvReused' })
    await message(link(), { eventId: 'EvReused' })
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/1700000000.000100`])
  })

  test('handles an event once although Slack retries it, and audits no delivery', async () => {
    await storeReview(review())
    await message(link(), { eventId: 'EvSame' })
    await message(link(), { eventId: 'EvSame', ts: '1700000000.000999' })
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/1700000000.000100`])
    expect((await store.audit.list()).events).toEqual([])
  })

  test('reads plain messages, thread replies and edits; skips bots, direct messages and other subtypes', () => {
    const base = { type: 'message', channel: BOUND, ts: '1.1', text: 'hi' }
    expect(slackMessageOf(base)).toEqual({ channel: BOUND, ts: '1.1', text: 'hi' })
    expect(slackMessageOf({ ...base, thread_ts: '1.0' })).toEqual({
      channel: BOUND,
      ts: '1.1',
      text: 'hi',
    })
    expect(slackMessageOf({ ...base, subtype: 'thread_broadcast' })?.ts).toBe('1.1')
    expect(slackMessageOf({ ...base, subtype: 'file_share' })?.ts).toBe('1.1')
    expect(slackMessageOf({ ...base, bot_id: 'B0123' })).toBeUndefined()
    expect(slackMessageOf({ ...base, subtype: 'bot_message' })).toBeUndefined()
    expect(slackMessageOf({ ...base, subtype: 'channel_join' })).toBeUndefined()
    expect(slackMessageOf({ ...base, channel_type: 'im' })).toBeUndefined()
    expect(slackMessageOf({ type: 'reaction_added', channel: BOUND })).toBeUndefined()
    expect(
      slackMessageOf({
        type: 'message',
        subtype: 'message_changed',
        channel: BOUND,
        message: { type: 'message', ts: '1.1', text: 'new' },
        previous_message: { type: 'message', ts: '1.1', text: 'old' },
      }),
    ).toEqual({ channel: BOUND, ts: '1.1', text: 'new', previousText: 'old' })
  })
})

describe('slack review status', () => {
  test('a link after a finished review gets the final emoji at once', async () => {
    await storeReview(review({ comments: [majorFinding] }))
    await message(`ready ${link()}`)
    expect(reactions).toEqual([`+red_circle ${BOUND}/1700000000.000100`])
    const [tracked] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    expect(tracked).toMatchObject({ status: 'changes', head: HEAD, reaction: 'red_circle' })
  })

  test('a link before the review shows nothing, then reviewing, then the verdict', async () => {
    await message(link())
    expect(reactions).toEqual([])
    const job = await queueReview()
    expect(reactions).toEqual([`+eyes ${BOUND}/1700000000.000100`])
    await finishReview(job, review({ comments: [{ ...majorFinding, severity: 'minor' }] }))
    expect(reactions).toEqual([
      `+eyes ${BOUND}/1700000000.000100`,
      `-eyes ${BOUND}/1700000000.000100`,
      `+large_orange_circle ${BOUND}/1700000000.000100`,
    ])
  })

  test('a new push swaps the verdict for reviewing, then the new verdict', async () => {
    await storeReview(review({ verdict: 'needs-changes' }))
    await message(link())
    expect((await pushed()).status).toBe(202)
    await settle()
    const [job] = await store.jobs.list({ status: ['queued'] })
    expect(job?.analyzer).toBe('review')
    if (!job) return
    await finishReview(job, review({ head: NEXT }))
    expect(reactions).toEqual([
      `+red_circle ${BOUND}/1700000000.000100`,
      `-red_circle ${BOUND}/1700000000.000100`,
      `+eyes ${BOUND}/1700000000.000100`,
      `-eyes ${BOUND}/1700000000.000100`,
      `+large_green_circle ${BOUND}/1700000000.000100`,
    ])
  })

  test('a review skipped as too large shows the not-reviewed emoji', async () => {
    await storeReview(
      review({
        mode: 'skipped',
        verdict: 'skipped',
        skipped: [{ path: 'src/widget.ts', reason: 'too-large' }],
      }),
    )
    await message(link())
    expect(reactions).toEqual([`+white_circle ${BOUND}/1700000000.000100`])
  })

  test('a run with nothing new to review keeps the earlier verdict', async () => {
    await storeReview(review())
    await message(link())
    await storeReview(review({ mode: 'skipped', verdict: 'skipped' }))
    await deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 7 })
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/1700000000.000100`])
  })

  test('a message linking several merge requests shows the worst status', async () => {
    await storeReview(review())
    await storeReview(
      review({ mergeRequest: { ...review().mergeRequest, id: 8 }, verdict: 'needs-changes' }),
    )
    await message(`${link('shapes/widget', 7)} and ${link('shapes/widget', 8)}`)
    expect(reactions).toEqual([`+red_circle ${BOUND}/1700000000.000100`])
    expect(
      (await store.slackMessages?.ofMessage(BOUND, '1700000000.000100'))?.map(
        (entry) => entry.status,
      ),
    ).toEqual(['clean', 'changes'])
  })

  test('emoji overrides keep skin tones and drop colons', async () => {
    await connect({ clean: ':white_check_mark:', reviewing: 'thumbsup::skin-tone-2' })
    await storeReview(review())
    await message(link())
    await queueReview(NEXT)
    expect(reactions).toEqual([
      `+white_check_mark ${BOUND}/1700000000.000100`,
      `-white_check_mark ${BOUND}/1700000000.000100`,
      `+thumbsup::skin-tone-2 ${BOUND}/1700000000.000100`,
    ])
  })

  test('a canceled review brings the earlier verdict back', async () => {
    await storeReview(review())
    await message(link())
    const job = await queueReview(NEXT)
    const canceled = await app.request(`/api/jobs/${job.id}/cancel`, { method: 'POST' })
    expect(canceled.status).toBe(200)
    await settle()
    expect(reactions.slice(-2)).toEqual([
      `-eyes ${BOUND}/1700000000.000100`,
      `+large_green_circle ${BOUND}/1700000000.000100`,
    ])
  })

  test('a link with another spelling of the path follows the same merge request', async () => {
    await storeReview(review({ verdict: 'needs-changes' }))
    await message(link('Shapes/Widget'))
    const job = await queueReview(NEXT)
    await finishReview(job, review({ head: NEXT }))
    expect(shownOn()).toEqual({ [`${BOUND}/1700000000.000100`]: ['large_green_circle'] })
  })

  test('concurrent updates of one message leave exactly one emoji', async () => {
    await message(link())
    slowMs = 20
    const job = await store.jobs.enqueue({
      analyzer: 'review',
      repo: widget,
      ref: HEAD,
      options: { mergeRequest: 7 },
      trigger: 'webhook',
      createdAt: NOW.toISOString(),
    })
    const queued = deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 7 })
    await Bun.sleep(5)
    await store.jobs.cancel(job.id, NOW.toISOString())
    await storeReview(review())
    const reviewed = deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 7 })
    await Promise.all([queued, reviewed])
    expect(shownOn()).toEqual({ [`${BOUND}/1700000000.000100`]: ['large_green_circle'] })
    const [tracked] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    expect(tracked?.reaction).toBe('large_green_circle')
  })

  test('a failed remove keeps the old emoji tracked and retries the swap later', async () => {
    await storeReview(review())
    await message(link())
    failing = { remove: 'ratelimited' }
    await queueReview(NEXT)
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/1700000000.000100`])
    const [tracked] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    expect(tracked).toMatchObject({ status: 'reviewing', reaction: 'large_green_circle' })
    failing = {}
    await deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 7 })
    expect(shownOn()).toEqual({ [`${BOUND}/1700000000.000100`]: ['eyes'] })
  })

  test('a message Slack no longer has is forgotten', async () => {
    await storeReview(review())
    await message(link())
    failing = { remove: 'message_not_found' }
    await queueReview(NEXT)
    expect(await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)).toEqual([])
  })

  test('a deleted message is forgotten', async () => {
    await storeReview(review())
    await message(link())
    await message('', {
      event: { subtype: 'message_deleted', deleted_ts: '1700000000.000100', text: undefined },
    })
    expect(await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)).toEqual([])
    await queueReview(NEXT)
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/1700000000.000100`])
  })

  test('the credential overrides the emoji', async () => {
    await connect({ clean: 'white_check_mark', reviewing: 'hourglass' })
    await storeReview(review())
    await message(link())
    await queueReview(NEXT)
    expect(reactions).toEqual([
      `+white_check_mark ${BOUND}/1700000000.000100`,
      `-white_check_mark ${BOUND}/1700000000.000100`,
      `+hourglass ${BOUND}/1700000000.000100`,
    ])
  })

  test('an edit handles only the links it added', async () => {
    await storeReview(review())
    await message('nothing yet')
    expect(reactions).toEqual([])
    await message('', {
      event: {
        subtype: 'message_changed',
        message: { type: 'message', ts: '1700000000.000100', text: `now ${link()}` },
        previous_message: { type: 'message', ts: '1700000000.000100', text: 'nothing yet' },
      },
    })
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/1700000000.000100`])
  })
})

describe('slack review gates', () => {
  test('merge request reviews off: no reaction at all', async () => {
    await setting('off', 'mergeRequests.comments', { groups: ['shapes'] }, { enabled: false })
    await storeReview(review())
    await message(link())
    await queueReview()
    expect(reactions).toEqual([])
    expect(await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)).toEqual([])
  })

  test('turning reviews off later removes the emoji', async () => {
    await message(link())
    await queueReview()
    await setting('off', 'mergeRequests.comments', { groups: ['shapes'] }, { enabled: false })
    await deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 7 })
    expect(reactions).toEqual([
      `+eyes ${BOUND}/1700000000.000100`,
      `-eyes ${BOUND}/1700000000.000100`,
    ])
    expect(await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)).toEqual([])
  })

  test('unbinding the channel later removes the emoji', async () => {
    await storeReview(review())
    await message(link())
    await bind([OTHER])
    await deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 7 })
    expect(shownOn()).toEqual({ [`${BOUND}/1700000000.000100`]: [] })
  })

  test('a channel not bound to the repository is ignored', async () => {
    await bind([OTHER], { groups: ['tools'] })
    await storeReview(review())
    await message(link(), { channel: OTHER })
    expect(reactions).toEqual([])
    await message(link('tools/gizmo', 3), { channel: BOUND })
    expect(reactions).toEqual([])
  })

  test('unknown repositories and hosts are ignored', async () => {
    await message('<https://git.acme.test/elsewhere/thing/-/merge_requests/2>')
    await message('<https://other.test/shapes/widget/-/merge_requests/7>')
    expect(reactions).toEqual([])
    expect(await store.slackMessages?.ofMessage(BOUND, '1700000000.000100')).toEqual([])
  })
})

const MR_URL = 'https://git.acme.test/shapes/widget/-/merge_requests'

const storeSecond = (overrides: Partial<ReviewData> = {}) =>
  storeReview(
    review({ mergeRequest: { ...review().mergeRequest, id: 8, title: 'Add gizmo' }, ...overrides }),
  )

describe('slack status reply', () => {
  test('two merge requests get one reply with a line each, and the worst reaction', async () => {
    await storeReview(review())
    await storeSecond({ verdict: 'needs-changes' })
    await message(`${link('shapes/widget', 7)} and ${link('shapes/widget', 8)}`)
    expect(reactions).toEqual([`+red_circle ${BOUND}/1700000000.000100`])
    expect(posts).toEqual([
      {
        channel: BOUND,
        threadTs: '1700000000.000100',
        ts: '1700000100.000001',
        text: [
          `:large_green_circle: Clean — <${MR_URL}/7|widget!7 Add widget>`,
          `:red_circle: Needs changes — <${MR_URL}/8|widget!8 Add gizmo>`,
        ].join('\n'),
      },
    ])
    expect(titleLookups).toEqual([])
    expect(await store.slackMessages?.replyOf(BOUND, '1700000000.000100')).toMatchObject({
      replyTs: '1700000100.000001',
    })
  })

  test('a status change edits the same reply', async () => {
    await storeReview(review())
    await storeSecond()
    await message(`${link('shapes/widget', 7)} ${link('shapes/widget', 8)}`)
    const [reply] = posts
    await queueReview(NEXT, 8)
    expect(posts).toHaveLength(1)
    expect(updates).toEqual([
      {
        channel: BOUND,
        ts: reply?.ts ?? '',
        text: [
          `:large_green_circle: Clean — <${MR_URL}/7|widget!7 Add widget>`,
          `:eyes: Reviewing — <${MR_URL}/8|widget!8 Add gizmo>`,
        ].join('\n'),
      },
    ])
    await deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 8 })
    expect(updates).toHaveLength(1)
  })

  test('a message with a single merge request gets no reply', async () => {
    await storeReview(review())
    await message(link())
    await queueReview(NEXT)
    expect(reactions.at(-1)).toBe(`+eyes ${BOUND}/1700000000.000100`)
    expect(posts).toEqual([])
    expect(updates).toEqual([])
  })

  test('a reply Slack no longer has is posted again and the new one is edited after', async () => {
    await storeReview(review())
    await storeSecond()
    await message(`${link('shapes/widget', 7)} ${link('shapes/widget', 8)}`)
    postFailing = { update: 'message_not_found' }
    await queueReview(NEXT, 8)
    expect(posts.map((post) => post.ts)).toEqual(['1700000100.000001', '1700000100.000002'])
    expect(posts[1]?.threadTs).toBe('1700000000.000100')
    expect((await store.slackMessages?.replyOf(BOUND, '1700000000.000100'))?.replyTs).toBe(
      '1700000100.000002',
    )
    postFailing = {}
    await queueReview(NEXT, 7)
    expect(updates.map((update) => update.ts)).toEqual(['1700000100.000002'])
  })

  test('without chat:write the reactions keep working and the scope is logged once', async () => {
    postFailing = { post: 'missing_scope' }
    await storeReview(review())
    await storeSecond()
    await message(`${link('shapes/widget', 7)} ${link('shapes/widget', 8)}`)
    await queueReview(NEXT, 8)
    await queueReview(NEXT, 7)
    expect(shownOn()).toEqual({ [`${BOUND}/1700000000.000100`]: ['eyes'] })
    expect(posts).toEqual([])
    expect(logs.filter((line) => line.includes('chat:write'))).toHaveLength(1)
  })

  test('titles not in a review come from the forge once and are kept on the rows', async () => {
    await message(`${link('shapes/widget', 7)} ${link('shapes/widget', 8)}`)
    expect(titleLookups).toEqual(['shapes/widget!7', 'shapes/widget!8'])
    expect(posts[0]?.text).toBe(
      [
        `Not reviewed — <${MR_URL}/7|widget!7 Add widget>`,
        `Not reviewed — <${MR_URL}/8|widget!8 Add widget>`,
      ].join('\n'),
    )
    await queueReview(HEAD, 8)
    expect(titleLookups).toHaveLength(2)
    expect(
      (await store.slackMessages?.ofMessage(BOUND, '1700000000.000100'))?.map((row) => row.title),
    ).toEqual(['Add widget', 'Add widget'])
  })

  test('a title the forge cannot give is asked once and logged once', async () => {
    titleFailing = true
    await message(`${link('shapes/widget', 7)} ${link('shapes/widget', 8)}`)
    await queueReview(HEAD, 8)
    await queueReview(NEXT, 7)
    expect(titleLookups).toEqual(['shapes/widget!7', 'shapes/widget!8'])
    expect(logs.filter((line) => line.includes('forge is down'))).toHaveLength(2)
    expect(updates.at(-1)?.text).toBe(
      [
        `:eyes: Reviewing — <${MR_URL}/7|widget!7>`,
        `:eyes: Reviewing — <${MR_URL}/8|widget!8>`,
      ].join('\n'),
    )
  })

  test('labels and links keep the path spelling of the repository', async () => {
    const spelled = 'https://git.acme.test/Labs/Gizmo/-/merge_requests'
    await bind([BOUND], { groups: ['labs'] })
    const data = review()
    await store.analyses.add({
      repo: { forge: 'acme', path: 'Labs/Gizmo' },
      kind: 'review',
      ref: '!7',
      createdAt: NOW.toISOString(),
      data,
      metrics: reviewMetrics(data),
    })
    await message(`${link('labs/gizmo', 7)} ${link('labs/gizmo', 8)}`)
    expect(posts[0]?.text).toBe(
      [
        `:large_green_circle: Clean — <${spelled}/7|Gizmo!7 Add widget>`,
        `Not reviewed — <${spelled}/8|Gizmo!8 Add widget>`,
      ].join('\n'),
    )
    expect(titleLookups).toEqual(['Labs/Gizmo!8'])
  })

  test('a gate closing for one merge request keeps the reply with the rest', async () => {
    await bind([BOUND], { groups: ['tools'] })
    await storeReview(review())
    await message(`${link('shapes/widget', 7)} ${link('tools/gizmo', 3)}`)
    expect(posts).toHaveLength(1)
    await setting('off', 'mergeRequests.comments', { groups: ['tools'] }, { enabled: false })
    await deps.mergeRequestStatus?.reviewChanged({
      repo: { forge: 'acme', path: 'tools/gizmo' },
      mergeRequest: 3,
    })
    expect(updates).toEqual([
      {
        channel: BOUND,
        ts: posts[0]?.ts ?? '',
        text: `:large_green_circle: Clean — <${MR_URL}/7|widget!7 Add widget>`,
      },
    ])
    expect(shownOn()).toEqual({ [`${BOUND}/1700000000.000100`]: ['large_green_circle'] })
  })

  test('two status changes at once post one reply', async () => {
    postFailing = { post: 'ratelimited' }
    await storeReview(review())
    await storeSecond()
    await message(`${link('shapes/widget', 7)} ${link('shapes/widget', 8)}`)
    expect(posts).toEqual([])
    postFailing = {}
    slowMs = 20
    await Promise.all([
      queueReview(NEXT, 7),
      deps.mergeRequestStatus?.reviewChanged({ repo: widget, mergeRequest: 8 }),
    ])
    await settle()
    expect(posts).toHaveLength(1)
    const final = updates.at(-1)?.text ?? posts[0]?.text
    expect(final).toBe(
      [
        `:eyes: Reviewing — <${MR_URL}/7|widget!7 Add widget>`,
        `:large_green_circle: Clean — <${MR_URL}/8|widget!8 Add gizmo>`,
      ].join('\n'),
    )
  })
})

const HK_SET = ['hk-reviewing', 'hk-clean', 'hk-minor', 'hk-changes', 'hk-skipped']
const TS = '1700000000.000100'

describe('slack custom emoji', () => {
  test("a workspace with Holtkeeper's emoji shows them", async () => {
    workspaceEmoji = new Set(HK_SET)
    await storeReview(review({ comments: [majorFinding] }))
    await message(`ready ${link()}`)
    expect(reactions).toEqual([`+hk-changes ${BOUND}/${TS}`])
    const [tracked] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    expect(tracked).toMatchObject({ status: 'changes', reaction: 'hk-changes' })
    await queueReview(NEXT)
    expect(reactions).toEqual([
      `+hk-changes ${BOUND}/${TS}`,
      `-hk-changes ${BOUND}/${TS}`,
      `+hk-reviewing ${BOUND}/${TS}`,
    ])
  })

  test('a missing custom emoji falls back and is not tried again, also by another process', async () => {
    await storeReview(review())
    await message(`ready ${link()}`)
    expect(attempts).toEqual(['hk-clean', 'large_green_circle'])
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/${TS}`])
    const [tracked] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    expect(tracked?.reaction).toBe('large_green_circle')

    attempts = []
    await message(`again ${link()}`, { ts: '1700000000.000200' })
    expect(attempts).toEqual(['large_green_circle'])

    attempts = []
    const other = createSlackReviews(deps, { log: (line) => logs.push(line) })
    await other.handleMessage({ channel: BOUND, ts: '1700000000.000300', text: link() })
    expect(attempts).toEqual(['large_green_circle'])
    expect(logs).toEqual([])
  })

  test('an unchanged status keeps its fallback once the missing emoji is forgotten', async () => {
    await storeReview(review())
    await message(`ready ${link()}`)
    attempts = []
    const later = createSlackReviews(
      { ...deps, now: () => new Date(NOW.getTime() + 7 * 60 * 60 * 1000) },
      { log: (line) => logs.push(line) },
    )
    await later.reviewChanged({ repo: widget, mergeRequest: 7 })
    expect(attempts).toEqual([])
    expect(reactions).toEqual([`+large_green_circle ${BOUND}/${TS}`])
  })

  test('an add that was never confirmed is removed on the next swap, custom and fallback alike', async () => {
    workspaceEmoji = new Set(HK_SET)
    await storeReview(review())
    await message(`ready ${link()}`)
    const [tracked] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    if (!tracked) throw new Error('no tracked message')
    await store.slackMessages?.put({ ...tracked, reaction: 'hk-clean|large_green_circle' })
    reactions = []
    await queueReview(NEXT)
    expect(reactions).toEqual([
      `-hk-clean ${BOUND}/${TS}`,
      `-large_green_circle ${BOUND}/${TS}`,
      `+hk-reviewing ${BOUND}/${TS}`,
    ])
    const [after] = (await store.slackMessages?.ofMergeRequest('acme:shapes/widget', 7)) ?? []
    expect(after?.reaction).toBe('hk-reviewing')
  })

  test('a swap removes the emoji actually added', async () => {
    await storeReview(review())
    await message(`ready ${link()}`)
    await queueReview(NEXT)
    expect(reactions).toEqual([
      `+large_green_circle ${BOUND}/${TS}`,
      `-large_green_circle ${BOUND}/${TS}`,
      `+eyes ${BOUND}/${TS}`,
    ])
    expect(attempts).toEqual(['hk-clean', 'large_green_circle', 'hk-reviewing', 'eyes'])
    expect(shownOn()).toEqual({ [`${BOUND}/${TS}`]: ['eyes'] })
  })

  test('an override the workspace lacks is not replaced and is logged once', async () => {
    await connect({ clean: 'hk-widget-ok' })
    await storeReview(review())
    await message(`ready ${link()}`)
    await message(`again ${link()}`, { ts: '1700000000.000200' })
    expect(attempts).toEqual(['hk-widget-ok', 'hk-widget-ok'])
    expect(reactions).toEqual([])
    expect(logs).toEqual([
      'slack reviews: the workspace has no emoji hk-widget-ok; fix the override under Settings › Integrations › Slack',
    ])
  })

  test('the status reply shows the emoji the reactions use', async () => {
    workspaceEmoji = new Set(HK_SET)
    await storeReview(review())
    await storeSecond({ verdict: 'needs-changes' })
    await message(`${link('shapes/widget', 7)} and ${link('shapes/widget', 8)}`)
    expect(reactions).toEqual([`+hk-changes ${BOUND}/${TS}`])
    expect(posts.map((post) => post.text)).toEqual([
      [
        `:hk-clean: Clean — <${MR_URL}/7|widget!7 Add widget>`,
        `:hk-changes: Needs changes — <${MR_URL}/8|widget!8 Add gizmo>`,
      ].join('\n'),
    ])
  })

  test('without the set the status reply shows the fallbacks', async () => {
    await storeReview(review())
    await storeSecond({ verdict: 'needs-changes' })
    await message(`${link('shapes/widget', 7)} and ${link('shapes/widget', 8)}`)
    expect(posts.map((post) => post.text)).toEqual([
      [
        `:large_green_circle: Clean — <${MR_URL}/7|widget!7 Add widget>`,
        `:red_circle: Needs changes — <${MR_URL}/8|widget!8 Add gizmo>`,
      ].join('\n'),
    ])
  })
})
