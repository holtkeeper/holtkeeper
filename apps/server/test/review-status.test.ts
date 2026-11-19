import { beforeEach, describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { Discussion, MergeRequest } from '@holtkeeper/forge'
import { type ReviewData, commentBody } from '@holtkeeper/review'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { reviewToolsAccess } from '../src/review-status.ts'
import { reviewsToolset } from '../src/tools/reviews.ts'

const mr: MergeRequest & { headSha: string } = {
  id: 7,
  title: 'Round the widget corners',
  description: '',
  sourceBranch: 'feature/round-widgets',
  targetBranch: 'main',
  state: 'open',
  draft: false,
  labels: [],
  author: 'jane',
  webUrl: 'https://forge.test/shapes/widget/-/merge_requests/7',
  headSha: 'bbbbbbbb1111',
}

const finding = {
  id: 'f1',
  path: 'src/widget.ts',
  line: 12,
  severity: 'major' as const,
  category: 'bug' as const,
  title: 'Radius can be negative',
  body: 'A negative radius renders nothing; clamp it to zero.',
  source: 'agent',
  posted: true,
}

let discussions: Discussion[]

const forge = {
  findMergeRequest: async (_repo: string, query: { sourceBranch: string }) =>
    query.sourceBranch === mr.sourceBranch ? mr : undefined,
  getMergeRequest: async (_repo: string, id: number) => {
    if (id === 500) throw Object.assign(new Error('bad gateway'), { status: 502 })
    if (id === 403) throw Object.assign(new Error('forbidden'), { status: 403 })
    if (id !== mr.id) throw Object.assign(new Error('not found'), { status: 404 })
    return mr
  },
  listDiscussions: async () => discussions,
}

const config = (onMergeRequest?: object) =>
  parseConfig({
    forges: { work: { kind: 'gitlab', url: 'https://forge.test', create: () => forge as never } },
    teams: { shapes: { owns: ['work:shapes/*'] }, colors: { owns: ['work:colors/*'] } },
    ...(onMergeRequest && { jobs: { onMergeRequest } }),
  })

const review = (fields: Partial<ReviewData>): ReviewData => ({
  mergeRequest: {
    id: mr.id,
    title: mr.title,
    webUrl: mr.webUrl,
    sourceBranch: mr.sourceBranch,
    targetBranch: mr.targetBranch,
    author: mr.author,
  },
  head: 'aaaaaaaa0000',
  mode: 'full',
  verdict: 'needs-changes',
  summary: 'One bug in the radius handling.',
  comments: [finding],
  threads: [],
  skipped: [],
  stats: {
    files: 1,
    changedLines: 20,
    dropped: { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 },
  },
  approved: false,
  checks: [],
  ...fields,
})

const repo = { forge: 'work', path: 'shapes/widget' }
let store: Store

const addReview = (createdAt: string, data: ReviewData) =>
  store.analyses.add({ repo, kind: 'review', ref: `!${mr.id}`, createdAt, data })

let clock: Date
const queued: string[] = []

const statusText = async (
  args: Record<string, unknown>,
  options: { onMergeRequest?: object; canRead?: boolean; readOnly?: boolean } = {},
) => {
  const access = reviewToolsAccess(
    {
      store,
      config: config(options.onMergeRequest),
      readOnly: async () => options.readOnly ?? false,
      onQueued: (job) => void queued.push(job.id),
      now: () => clock,
    },
    (target) => (options.canRead ?? true) && target.teams.includes('shapes'),
  )
  const [tool] = reviewsToolset(access).tools
  return tool!.run(args, { dir: '.', signal: new AbortController().signal })
}

const reviewJobs = () => store.jobs.list({ repo, analyzer: 'review', limit: 50 })

beforeEach(() => {
  store = memoryStore()
  discussions = []
  clock = new Date('2026-11-10T14:00:00.000Z')
  queued.length = 0
})

const endJob = async (how: 'fail' | 'block' | 'cancel') => {
  const job = await store.jobs.enqueue({
    analyzer: 'review',
    repo,
    ref: mr.headSha,
    options: { mergeRequest: mr.id },
    trigger: 'webhook',
    createdAt: '2026-11-10T13:00:00.000Z',
  })
  const at = '2026-11-10T13:05:00.000Z'
  if (how === 'cancel') return store.jobs.cancel(job.id, at)
  await store.jobs.claim('w1', '2026-11-10T13:01:00.000Z')
  return how === 'block'
    ? store.jobs.block(job.id, { at, error: 'weekly AI budget reached' })
    : store.jobs.fail(job.id, { at, error: 'provider error' })
}
const queuedJobs = async () => (await reviewJobs()).filter((job) => job.status === 'queued')

const otherReviews = async (count: number) => {
  for (let index = 0; index < count; index++)
    // oxlint-disable-next-line no-await-in-loop -- fixtures in order
    await store.analyses.add({
      repo,
      kind: 'review',
      ref: `!${100 + index}`,
      createdAt: `2026-11-11T10:${String(index % 60).padStart(2, '0')}:${String(index % 50).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
      data: review({}),
    })
}

describe('code_review', () => {
  test('finds the merge request by branch and lists findings, open threads and what to do', async () => {
    await addReview('2026-11-10T10:00:00.000Z', review({}))
    discussions = [
      {
        id: 'd1',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'holtkeeper',
            body: commentBody(finding),
            createdAt: '2026-11-10T10:00:00.000Z',
            system: false,
          },
          {
            id: 2,
            author: 'jane',
            body: 'Why zero?',
            createdAt: '2026-11-10T11:00:00.000Z',
            system: false,
          },
        ],
      },
      { id: 'd2', resolvable: true, resolved: false, notes: [] },
    ]
    const text = await statusText(
      { repo: 'work:shapes/widget', branch: 'feature/round-widgets' },
      { onMergeRequest: { analyzers: ['review'] } },
    )
    expect(text).toContain('## work:shapes/widget!7 Round the widget corners')
    expect(text).toContain(
      '**Review: Needs changes** (full, 2026-11-10T10:00:00.000Z, reviewed aaaaaaaa, older than the head)',
    )
    expect(text).toContain('- **major** · bug · `src/widget.ts:12` — **Radius can be negative**')
    expect(text).toContain('### Open Holtkeeper threads (1)')
    expect(text).toContain('Radius can be negative (1 reply)')
    expect(text).toContain('Reviews start by themselves on new commits and one for bbbbbbbb')
    expect(text).toContain('Fix the open threads')
    expect(await reviewJobs()).toHaveLength(0)
  })

  test('reports a running review, earlier runs and resolved threads after fixes', async () => {
    await addReview('2026-11-10T10:00:00.000Z', review({}))
    await addReview(
      '2026-11-10T12:00:00.000Z',
      review({
        head: mr.headSha,
        mode: 'incremental',
        verdict: 'looks-good',
        comments: [],
        threads: [
          {
            discussionId: 'd1',
            action: 'resolved',
            path: 'src/widget.ts',
            line: 12,
            reason: 'Clamped now.',
          },
        ],
      }),
    )
    await store.jobs.enqueue({
      analyzer: 'review',
      repo,
      ref: 'cccccccc2222',
      options: { mergeRequest: mr.id },
      trigger: 'webhook',
      createdAt: '2026-11-10T13:00:00.000Z',
    })
    const text = await statusText({ repo: 'work:shapes/widget', mergeRequest: 7 })
    expect(text).toContain('**Review: Looks good** (incremental')
    expect(text).toContain('- Resolved · `src/widget.ts:12`: Clamped now.')
    expect(text).toContain('### Open Holtkeeper threads (0)')
    expect(text).toContain('Needs changes · 1 findings, 0 threads resolved')
    expect(text).toContain('A review is queued for cccccccc')
  })

  test('queues a plain review of the head once when none runs by itself', async () => {
    const args = { repo: 'work:shapes/widget', branch: 'feature/round-widgets' }
    const text = await statusText(args)
    expect(text).toContain('**Review:** none yet')
    expect(text).toContain('A review of bbbbbbbb was queued just now; call code_review again')
    const [job] = await reviewJobs()
    expect(job).toMatchObject({
      ref: mr.headSha,
      options: { mergeRequest: 7 },
      trigger: 'command',
      status: 'queued',
    })
    expect(queued).toEqual([job!.id])

    expect(await statusText(args)).toContain('A review is queued for bbbbbbbb')
    expect(await reviewJobs()).toHaveLength(1)
  })

  test('leaves new commits to the automatic review, then queues one if it never came', async () => {
    const args = { repo: 'work:shapes/widget', mergeRequest: 7 }
    const options = { onMergeRequest: { analyzers: ['review'] } }
    expect(await statusText(args, options)).toContain('Reviews start by themselves')
    clock = new Date(clock.getTime() + 30_000)
    expect(await statusText(args, options)).toContain('Reviews start by themselves')
    expect(await reviewJobs()).toHaveLength(0)
    clock = new Date(clock.getTime() + 31_000)
    expect(await statusText(args, options)).toContain('was queued just now')
    expect(await reviewJobs()).toHaveLength(1)
  })

  test('queues nothing for a frozen repository or a reviewed head', async () => {
    const args = { repo: 'work:shapes/widget', mergeRequest: 7 }
    expect(await statusText(args, { readOnly: true })).toContain('The repository is frozen')
    await addReview('2026-11-10T12:00:00.000Z', review({ head: mr.headSha, comments: [] }))
    expect(await statusText(args)).not.toContain('queued')
    expect(await reviewJobs()).toHaveLength(0)
  })

  test('tells a missing merge request, missing access and a forge outage apart', async () => {
    expect(statusText({ repo: 'work:shapes/widget', mergeRequest: 8 })).rejects.toThrow(
      'Holtkeeper sees no merge request !8 in work:shapes/widget',
    )
    expect(statusText({ repo: 'work:shapes/widget', mergeRequest: 403 })).rejects.toThrow(
      'Holtkeeper could not read merge requests of work:shapes/widget: forbidden. Ask a maintainer to give it access',
    )
    expect(statusText({ repo: 'work:shapes/widget', mergeRequest: 500 })).rejects.toThrow(
      'The forge did not answer for work:shapes/widget: bad gateway. Try again in a moment.',
    )
  })

  test('a run that found nothing new covers the head', async () => {
    await addReview('2026-11-10T10:00:00.000Z', review({}))
    await addReview(
      '2026-11-10T12:00:00.000Z',
      review({ head: mr.headSha, mode: 'skipped', verdict: 'skipped', comments: [] }),
    )
    const text = await statusText({ repo: 'work:shapes/widget', mergeRequest: 7 })
    expect(text).toContain('The newest commits brought nothing new to review.')
    expect(await reviewJobs()).toHaveLength(0)
  })

  test('a review the budget stopped or someone canceled is not queued again', async () => {
    const args = { repo: 'work:shapes/widget', mergeRequest: 7 }
    await endJob('block')
    expect(await statusText(args)).toContain('The AI budget stopped the review of this commit')
    expect(await queuedJobs()).toHaveLength(0)

    store = memoryStore()
    await endJob('cancel')
    expect(await statusText(args)).toContain('was canceled and was not queued again')
    expect(await queuedJobs()).toHaveLength(0)
  })

  test('a failed review of the head is tried once more, then left', async () => {
    const args = { repo: 'work:shapes/widget', mergeRequest: 7 }
    await endJob('fail')
    expect(await statusText(args, { onMergeRequest: { analyzers: ['review'] } })).toContain(
      'The last review job failed (provider error). A review of bbbbbbbb was queued just now',
    )
    const [retry] = await queuedJobs()
    await store.jobs.claim('w1', '2026-11-10T14:01:00.000Z')
    await store.jobs.fail(retry!.id, { at: '2026-11-10T14:02:00.000Z', error: 'provider error' })
    expect(await statusText(args)).toContain('failed (provider error) and was not queued again')
    expect(await queuedJobs()).toHaveLength(0)
  })

  test('in a busy repository a new merge request still gets its first review', async () => {
    await otherReviews(120)
    const text = await statusText({ repo: 'work:shapes/widget', mergeRequest: 7 })
    expect(text).toContain('was queued just now')
    expect(await queuedJobs()).toHaveLength(1)
  })

  test('a head reviewed before many newer records of other merge requests stays reviewed', async () => {
    await addReview('2026-11-10T12:00:00.000Z', review({ head: mr.headSha, comments: [] }))
    await otherReviews(120)
    const text = await statusText({ repo: 'work:shapes/widget', mergeRequest: 7 })
    expect(text).not.toContain('queued')
    expect(text).not.toContain('nothing new to review')
    expect(await queuedJobs()).toHaveLength(0)
  })

  test('a review the budget stopped in an earlier week is queued again', async () => {
    await endJob('block')
    clock = new Date('2026-11-17T09:00:00.000Z')
    expect(await statusText({ repo: 'work:shapes/widget', mergeRequest: 7 })).toContain(
      'was queued just now',
    )
  })

  test('a request that fails to queue leaves no phantom review behind', async () => {
    const args = { repo: 'work:shapes/widget', mergeRequest: 7 }
    const enqueue = store.jobs.enqueue.bind(store.jobs)
    store.jobs.enqueue = async () => {
      throw new Error('db down')
    }
    expect(statusText(args)).rejects.toThrow('db down')
    await Bun.sleep(0)
    store.jobs.enqueue = enqueue
    expect(await statusText(args)).toContain('was queued just now')
    expect(await queuedJobs()).toHaveLength(1)
  })

  test('requests made at the same time queue one review', async () => {
    const args = { repo: 'work:shapes/widget', mergeRequest: 7 }
    const texts = await Promise.all([statusText(args), statusText(args), statusText(args)])
    expect(texts.filter((text) => text.includes('was queued just now'))).toHaveLength(1)
    expect(await queuedJobs()).toHaveLength(1)
  })

  test('refuses unreadable repositories, unknown branches and missing arguments', async () => {
    expect(statusText({ repo: 'work:colors/red', branch: 'x' })).rejects.toThrow(
      'No repository work:colors/red you may read reviews of',
    )
    expect(
      statusText({ repo: 'work:shapes/widget', branch: 'x' }, { canRead: false }),
    ).rejects.toThrow('you may read reviews of')
    expect(statusText({ repo: 'work:shapes/widget', branch: 'feature/none' })).rejects.toThrow(
      'there is none from branch feature/none in work:shapes/widget. Push the branch, open a merge request',
    )
    expect(statusText({ repo: 'work:shapes/widget' })).rejects.toThrow(
      'Pass branch or mergeRequest.',
    )
  })
})
