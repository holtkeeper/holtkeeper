import { beforeEach, describe, expect, test } from 'bun:test'

import { createTranscript } from '@holtkeeper/agent'
import type {
  AgentTranscriptView,
  Job,
  JobAnalyzerList,
  JobCountView,
  JobFailureList,
  JobList,
  JobLog,
  JobRunList,
  JobStats,
  JobTargetList,
  JobWhy,
} from '@holtkeeper/api'
import { type ArtifactStore, memoryArtifactStore } from '@holtkeeper/artifacts'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { createJobLog, touchWorker } from '@holtkeeper/jobs'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import type { JobAnalyzerInfo } from '../src/context.ts'
import { storeTranscript } from '../src/transcripts.ts'

const forge = { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never }

const baseConfig = {
  forges: { work: forge },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
}
const config = parseConfig({
  ...baseConfig,
  jobs: {
    onTag: { analyzers: ['changelog', 'fleet', 'unknown'], groups: ['games'] },
    webhookSecret: 'hook-secret',
  },
})

const analyzers: JobAnalyzerInfo[] = [
  { kind: 'changelog', scope: 'repo', options: z.object({ from: z.string().optional() }) },
  { kind: 'fleet', scope: 'group', options: z.object({}) },
]

const games = headerAuth({
  roles: {
    games: [{ scope: { groups: ['games'] }, actions: ['analyses:read', 'analyses:run'] }],
    reader: [{ scope: { groups: ['games'] }, actions: ['analyses:read'] }],
  },
})
const asGames = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'games' }
const asReader = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'reader' }

let store: Store
let artifacts: ArtifactStore

const enqueueChangelog = (path: string) =>
  store.jobs.enqueue({
    analyzer: 'changelog',
    repo: { forge: 'work', path },
    trigger: 'manual',
    createdAt: '2026-10-30T10:00:00.000Z',
  })
const setup = (auth: AuthProvider = noAuth(), cfg = config, list = analyzers) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config: cfg,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: builtinSettings,
    analyses: [],
    analyzers: list,
    artifacts,
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const send = (
  app: ReturnType<typeof setup>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(() => {
  store = memoryStore()
  artifacts = memoryArtifactStore()
})

const failJob = async (path: string, minute: number, error: string) => {
  const queued = await store.jobs.enqueue({
    analyzer: 'changelog',
    repo: { forge: 'work', path },
    trigger: 'schedule',
    createdAt: `2026-10-30T10:${String(minute).padStart(2, '0')}:00.000Z`,
    maxAttempts: 1,
  })
  await store.jobs.claim('w1', queued.createdAt)
  await store.jobs.fail(queued.id, { at: queued.createdAt, error, step: 'analyze' })
  return queued
}

describe('job routes', () => {
  test('queues, lists, shows and cancels jobs', async () => {
    const app = setup()
    const created = await send(app, 'POST', '/api/jobs', {
      analyzer: 'changelog',
      repo: 'work:games/a',
      ref: 'v1.2.0',
      options: { from: 'v1.1.0' },
    })
    expect(created.status).toBe(201)
    const job = (await created.json()) as Job
    expect(job).toMatchObject({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      ref: 'v1.2.0',
      trigger: 'manual',
      status: 'queued',
      actor: 'root',
    })

    const group = (await (
      await send(app, 'POST', '/api/jobs', { analyzer: 'fleet', group: 'games' })
    ).json()) as Job
    expect(group).toMatchObject({ repo: { forge: 'work', path: 'games' }, group: 'games' })

    const list = (await (await app.request('/api/jobs?status=queued&limit=10')).json()) as JobList
    expect(list.jobs.map((j) => j.analyzer)).toEqual(['fleet', 'changelog'])
    const byRepo = (await (await app.request('/api/jobs?repo=work:games/a')).json()) as JobList
    expect(byRepo.jobs.map((j) => j.id)).toEqual([job.id])
    const byAnalyzer = (await (await app.request('/api/jobs?analyzer=fleet')).json()) as JobList
    expect(byAnalyzer.jobs.map((j) => j.id)).toEqual([group.id])
    expect((await app.request('/api/jobs?status=bogus')).status).toBe(400)
    expect(list.people).toEqual({})
    const manual = (await (await app.request('/api/jobs?trigger=manual')).json()) as JobList
    expect(manual.jobs).toHaveLength(2)
    expect((await (await app.request('/api/jobs?trigger=tag')).json()) as JobList).toMatchObject({
      jobs: [],
    })
    expect((await app.request('/api/jobs?trigger=bogus')).status).toBe(400)
    const some = (await (
      await app.request('/api/jobs?repos=work:games,work:tools/x')
    ).json()) as JobList
    expect(some.jobs.map((j) => j.id)).toEqual([group.id])
    expect((await app.request('/api/jobs?repos=nope')).status).toBe(400)

    const detail = (await (await app.request(`/api/jobs/${job.id}`)).json()) as Job
    expect(detail).toMatchObject({ id: job.id, attemptsHistory: [] })
    expect((await app.request('/api/jobs/missing')).status).toBe(404)

    const canceled = await send(app, 'POST', `/api/jobs/${job.id}/cancel`)
    expect(((await canceled.json()) as Job).status).toBe('canceled')
    expect((await send(app, 'POST', `/api/jobs/${job.id}/cancel`)).status).toBe(409)
    const audited = (await store.audit.list({ action: 'job.', outcome: 'ok' })).events
    expect(audited.map((e) => e.action).toSorted()).toEqual([
      'job.cancel',
      'job.create',
      'job.create',
    ])
    expect(audited.find((e) => e.action === 'job.cancel')?.target).toEqual({
      type: 'job',
      id: job.id,
      repo: 'work:games/a',
    })
  })

  test('validates analyzer, target and options', async () => {
    const app = setup()
    const error = async (body: unknown) => {
      const response = await send(app, 'POST', '/api/jobs', body)
      expect(response.status).toBe(400)
      return ((await response.json()) as { error: string }).error
    }
    expect(await error({ analyzer: 'nope', repo: 'work:games/a' })).toContain('unknown analyzer')
    expect(await error({ analyzer: 'changelog', group: 'games' })).toContain('pass repo')
    expect(await error({ analyzer: 'fleet', repo: 'work:games/a' })).toContain('pass group')
    expect(await error({ analyzer: 'fleet', group: 'nope' })).toContain('unknown group')
    expect(await error({ analyzer: 'changelog', repo: 'other:games/a' })).toContain(
      'not configured',
    )
    expect(
      await error({ analyzer: 'changelog', repo: 'work:games/a', options: { from: 1 } }),
    ).toContain('from')
  })

  test('serves the transcripts of a job to whoever may read the job, and only its own', async () => {
    const mine = await enqueueChangelog('games/a')
    const theirs = await enqueueChangelog('tools/cli')
    const record = async (jobId: string, text: string) => {
      const transcript = createTranscript()
      transcript.write({ type: 'assistant', text })
      const ref = await storeTranscript(artifacts, transcript, {
        repo: 'work:games/a',
        taskKind: 'review',
        job: jobId,
      })
      await store.aiUsage.append({
        at: '2026-10-30T10:05:00.000Z',
        repo: { forge: 'work', path: 'games/a' },
        groups: ['games'],
        taskKind: 'review',
        jobId,
        actor: 'system',
        provider: 'Gateway',
        model: 'claude-sonnet-5-5',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        costSource: 'reported',
        durationMs: 10,
        turns: 1,
        outcome: 'ok',
        transcriptRef: ref,
      })
      return ref
    }
    const ref = await record(mine.id, 'looked at the widget')
    const other = await record(theirs.id, 'looked at the sprocket')
    const plain = (await artifacts.put(new TextEncoder().encode('{}'))).id

    const app = setup(games)
    const list = (await (
      await app.request(`/api/jobs/${mine.id}/runs`, { headers: asReader })
    ).json()) as JobRunList
    expect(list.runs.map((run) => run.transcriptRef)).toEqual([ref])
    expect(list.costUsd).toBeCloseTo(0.01)
    const view = (await (
      await app.request(`/api/jobs/${mine.id}/transcripts/${ref}`, { headers: asReader })
    ).json()) as AgentTranscriptView
    expect(view.lines).toMatchObject([{ type: 'assistant', text: 'looked at the widget' }])

    const status = async (path: string) => (await app.request(path, { headers: asReader })).status
    expect(await status(`/api/jobs/${mine.id}/transcripts/${other}`)).toBe(404)
    expect(await status(`/api/jobs/${mine.id}/transcripts/${plain}`)).toBe(404)
    expect(await status(`/api/jobs/${theirs.id}/runs`)).toBe(403)
    expect(await status(`/api/jobs/${theirs.id}/transcripts/${other}`)).toBe(403)
  })

  test('serves an attempt log in pages', async () => {
    const queued = await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: '2026-10-30T10:00:00.000Z',
    })
    const app = setup()
    const empty = (await (await app.request(`/api/jobs/${queued.id}/log`)).json()) as JobLog
    expect(empty).toMatchObject({ attempt: 0, attempts: 0, total: 0, lines: [] })

    await store.jobs.claim('w1', '2026-10-30T10:01:00.000Z')
    const log = createJobLog(artifacts, { jobId: queued.id, attempt: 1, flushLines: 4 })
    await log.step('analyze', async () => {
      for (let i = 0; i < 9; i++) log.write(`widget ${i}`)
    })
    await log.close()

    const first = (await (
      await app.request(`/api/jobs/${queued.id}/log?offset=2&limit=3`)
    ).json()) as JobLog
    expect(first).toMatchObject({ attempt: 1, attempts: 1, total: 11, offset: 2, complete: true })
    expect(first.lines.map((line) => line.text)).toEqual(['widget 1', 'widget 2', 'widget 3'])
    expect(first.lines.every((line) => line.step === 'analyze')).toBeTrue()
    const tail = (await (await app.request(`/api/jobs/${queued.id}/log?tail=1`)).json()) as JobLog
    expect(tail.lines).toMatchObject([{ mark: 'end', step: 'analyze' }])
    expect(tail.steps).toMatchObject([{ name: 'analyze', depth: 0, status: 'succeeded' }])
    expect((await app.request(`/api/jobs/${queued.id}/log?attempt=2`)).status).toBe(404)
    expect((await app.request(`/api/jobs/${queued.id}/log?offset=-1`)).status).toBe(400)
    expect((await app.request('/api/jobs/missing/log')).status).toBe(404)
  })

  test('groups failures by signature and filters jobs by it, within what the caller sees', async () => {
    const first = await failJob('games/a', 1, 'timeout after 30s')
    const second = await failJob('games/b', 2, 'timeout after 45s')
    await failJob('tools/x', 3, 'timeout after 50s')
    await failJob('games/a', 4, 'quota exceeded')
    const app = setup(games)

    const groups = (await (
      await app.request('/api/jobs/failures', { headers: asGames })
    ).json()) as JobFailureList
    expect(groups.failures).toMatchObject([
      { analyzer: 'changelog', errorSignature: 'quota exceeded', count: 1 },
      {
        analyzer: 'changelog',
        errorSignature: 'timeout after <n>s',
        count: 2,
        repos: 2,
        latestJobId: second.id,
      },
    ])
    const same = (await (
      await app.request(`/api/jobs?signature=${encodeURIComponent('timeout after <n>s')}`, {
        headers: asGames,
      })
    ).json()) as JobList
    expect(same.jobs.map((job) => job.id)).toEqual([second.id, first.id])
    expect(same.jobs[0]?.attemptsHistory).toMatchObject([{ status: 'failed', step: 'analyze' }])

    const everything = (await (
      await setup().request('/api/jobs/failures?days=1')
    ).json()) as JobFailureList
    expect(
      everything.failures.find((group) => group.errorSignature !== 'quota exceeded')?.count,
    ).toBe(3)
    expect((await setup().request('/api/jobs/failures?days=x')).status).toBe(400)
  })

  test('lists visible job targets with their groups and narrows lists to requested ones', async () => {
    await enqueueChangelog('games/a')
    await enqueueChangelog('tools/x')
    const app = setup(games)
    const targets = (await (
      await app.request('/api/jobs/targets', { headers: asGames })
    ).json()) as JobTargetList
    expect(targets.targets).toEqual([{ repo: 'work:games/a', groups: ['games'] }])
    const hidden = (await (
      await app.request('/api/jobs?repos=work:tools/x', { headers: asGames })
    ).json()) as JobList
    expect(hidden.jobs).toEqual([])
    const all = (await (await setup().request('/api/jobs/targets')).json()) as JobTargetList
    expect(all.targets.map((target) => target.repo)).toEqual(['work:games/a', 'work:tools/x'])
  })

  test('explains why a job ran and what keeps a queued one waiting', async () => {
    const running = await enqueueChangelog('games/a')
    await store.jobs.claim('w1', '2026-10-30T10:01:00.000Z')
    const waiting = await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'schedule',
      schedule: 'nightly',
      createdAt: '2026-10-30T11:00:00.000Z',
    })
    const app = setup()
    const why = (await (await app.request(`/api/jobs/${waiting.id}/why`)).json()) as JobWhy
    expect(why).toMatchObject({
      origin: 'Schedule nightly queued it',
      wait: { reasons: [{ kind: 'same-analyzer', analyzer: 'changelog' }], ahead: 0 },
      mode: 'host',
      people: {},
    })
    expect(why.costCapUsd).toBeUndefined()
    const listed = (await (await app.request('/api/jobs')).json()) as JobList
    expect(listed.waitHints).toEqual({
      [waiting.id]: { reasons: [{ kind: 'same-analyzer', analyzer: 'changelog' }], ahead: 0 },
    })
    const ran = (await (await app.request(`/api/jobs/${running.id}/why`)).json()) as JobWhy
    expect(ran.origin).toBe('A person queued it by hand')
    expect(ran.outcome).toStartWith('Running on w1')
    expect(ran.wait).toBeUndefined()
    expect((await app.request('/api/jobs/missing/why')).status).toBe(404)
  })

  test('applies visibility before the limit', async () => {
    for (let i = 0; i < 3; i++)
      await store.jobs.enqueue({
        analyzer: 'changelog',
        repo: { forge: 'work', path: 'tools/x' },
        trigger: 'schedule',
        createdAt: `2026-10-30T11:0${i}:00.000Z`,
      })
    await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'schedule',
      createdAt: '2026-10-30T10:00:00.000Z',
    })
    const list = (await (
      await setup(games).request('/api/jobs?limit=1', { headers: asGames })
    ).json()) as JobList
    expect(list.jobs.map((job) => job.repo.path)).toEqual(['games/a'])
  })

  test('searches jobs by repository, id, analyzer and its label within what the caller sees', async () => {
    const labelled: JobAnalyzerInfo[] = [
      { ...analyzers[0]!, analysis: { label: 'Release notes' } },
      analyzers[1]!,
    ]
    const widget = await enqueueChangelog('games/widget-kit')
    const other = await enqueueChangelog('tools/widget-cli')
    const fleet = await store.jobs.enqueue({
      analyzer: 'fleet',
      repo: { forge: 'work', path: 'games' },
      group: 'games',
      trigger: 'schedule',
      createdAt: '2026-10-30T11:00:00.000Z',
    })
    const ids = async (q: string, auth: AuthProvider = noAuth(), headers = {}) => {
      const response = await setup(auth, config, labelled).request(
        `/api/jobs?q=${encodeURIComponent(q)}`,
        { headers },
      )
      return ((await response.json()) as JobList).jobs.map((job) => job.id)
    }

    expect((await ids('WIDGET')).toSorted()).toEqual([widget.id, other.id].toSorted())
    expect(await ids('widget', games, asGames)).toEqual([widget.id])
    expect(await ids(other.id.slice(0, 8))).toEqual([other.id])
    expect(await ids('release')).toEqual(expect.arrayContaining([widget.id, other.id]))
    expect(await ids('release')).not.toContain(fleet.id)
    expect(await ids('flee')).toEqual([fleet.id])
    expect((await ids('   ')).length).toBe(3)
    const counted = await setup(games, config, labelled).request('/api/jobs/count?q=widget', {
      headers: asGames,
    })
    expect(((await counted.json()) as JobCountView).total).toBe(1)
    expect((await setup().request(`/api/jobs?q=${'x'.repeat(201)}`)).status).toBe(400)
  })

  test('counts jobs by status within what the caller may read', async () => {
    const done = await enqueueChangelog('games/a')
    await store.jobs.claim('w1', '2026-10-30T10:00:00.000Z')
    await store.jobs.complete(done.id, { at: '2026-10-30T10:01:00.000Z', analysisId: 'a-1' })
    await failJob('tools/x', 20, 'boom')
    await enqueueChangelog('games/b')
    await store.jobs.enqueue({
      analyzer: 'fleet',
      repo: { forge: 'work', path: 'tools' },
      group: 'tools',
      trigger: 'schedule',
      createdAt: '2026-10-30T11:00:00.000Z',
    })
    const count = async (path: string, headers: Record<string, string> = {}) => {
      const response = await setup(games).request(path, { headers })
      return { status: response.status, body: (await response.json()) as JobCountView }
    }

    const all = await setup().request('/api/jobs/count')
    expect(((await all.json()) as JobCountView).byStatus).toEqual({
      queued: 2,
      running: 0,
      succeeded: 1,
      failed: 1,
      blocked: 0,
      canceled: 0,
    })
    const narrow = await count('/api/jobs/count', asGames)
    expect(narrow.body).toEqual({
      total: 2,
      byStatus: { queued: 1, running: 0, succeeded: 1, failed: 0, blocked: 0, canceled: 0 },
    })
    expect((await count('/api/jobs/count?repos=work:tools/x', asGames)).body.total).toBe(0)
    expect((await count('/api/jobs/count?status=queued', asGames)).body.total).toBe(1)
    expect((await count('/api/jobs/count?since=2026-10-30T10:30:00Z', asGames)).body.total).toBe(0)
    expect((await count('/api/jobs/count?since=soon', asGames)).status).toBe(400)
    expect((await setup(games).request('/api/jobs/count')).status).toBe(401)
  })

  test('queue stats cover only what the caller may read; workers only for global readers', async () => {
    const agentAnalyzers: JobAnalyzerInfo[] = [
      ...analyzers,
      {
        kind: 'review',
        scope: 'repo',
        options: z.object({ budgetUsd: z.number().optional() }),
        needs: { agent: 'required' },
      },
    ]
    await failJob('games/b', 30, 'boom')
    await failJob('tools/x', 31, 'boom')
    const running = await store.jobs.enqueue({
      analyzer: 'review',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      options: { budgetUsd: 0.5 },
      createdAt: '2026-10-30T11:00:00.000Z',
    })
    await store.jobs.claim('worker-a', '2026-10-30T11:00:30.000Z')
    const hidden = await store.jobs.enqueue({
      analyzer: 'review',
      repo: { forge: 'work', path: 'tools/x' },
      trigger: 'manual',
      createdAt: '2026-10-30T11:01:00.000Z',
    })
    await store.jobs.claim('worker-a', '2026-10-30T11:03:00.000Z')
    await store.jobs.enqueue({
      analyzer: 'review',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'manual',
      createdAt: '2026-10-30T11:05:00.000Z',
    })
    await enqueueChangelog('games/b')
    await enqueueChangelog('tools/y')
    const costs = [
      [running.id, 'games/a', 0.25],
      [hidden.id, 'tools/x', 4],
    ] as const
    await Promise.all(
      costs.map(([jobId, path, costUsd]) =>
        store.aiUsage.append({
          at: '2026-10-30T11:30:00.000Z',
          repo: { forge: 'work', path },
          groups: [path.split('/')[0]!],
          taskKind: 'review',
          actor: 'system',
          provider: 'anthropic',
          model: 'claude-sonnet',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd,
          costSource: 'computed',
          durationMs: 1,
          turns: 1,
          outcome: 'ok',
          jobId,
        }),
      ),
    )
    await touchWorker(store.kv!, 'worker-a', new Date('2026-10-30T11:59:30.000Z'))
    await touchWorker(store.kv!, 'worker-gone', new Date('2026-10-30T11:00:00.000Z'))

    const stats = async (auth: AuthProvider, headers: Record<string, string> = {}, query = '') =>
      (await (
        await setup(auth, config, agentAnalyzers).request(`/api/jobs/stats${query}`, { headers })
      ).json()) as JobStats

    const gamesAi = headerAuth({
      roles: {
        games: [
          { scope: { groups: ['games'] }, actions: ['analyses:read', 'analyses:run', 'ai:read'] },
        ],
      },
    })
    expect((await stats(games, asGames)).running).toEqual({ jobs: 1 })
    const narrow = await stats(gamesAi, asGames)
    expect(narrow).toMatchObject({
      windowHours: 24,
      queue: { queued: 2, running: 1, failed: 1, blocked: 0 },
      claimLatency: { samples: 2, p50Ms: 0, p95Ms: 30_000 },
      waits: {
        sampled: 2,
        reasons: [
          { kind: 'capacity', count: 1 },
          { kind: 'same-analyzer', count: 1 },
        ],
      },
      running: { jobs: 1, costUsd: 0.25 },
    })
    expect(narrow.workers).toBeUndefined()
    expect(JSON.stringify(narrow)).not.toContain('night window')

    const everything = await stats(noAuth())
    expect(everything.queue).toEqual({ queued: 3, running: 2, failed: 2, blocked: 0 })
    expect(everything.running).toEqual({ jobs: 2, costUsd: 4.25 })
    expect(everything.workers).toEqual([
      { id: 'worker-a', lastSeen: '2026-10-30T11:59:30.000Z', running: 2 },
    ])
    expect((await stats(noAuth(), {}, '?repos=work:tools/y')).queue.queued).toBe(1)
    expect((await stats(games, asGames, '?repos=work:tools/y')).queue.queued).toBe(0)

    const listed = (await (
      await setup(gamesAi, config, agentAnalyzers).request('/api/jobs', { headers: asGames })
    ).json()) as JobList
    expect(listed.costs).toEqual({ [running.id]: 0.25 })
    const withoutAi = (await (
      await setup(games, config, agentAnalyzers).request('/api/jobs', { headers: asGames })
    ).json()) as JobList
    expect(withoutAi.costs).toEqual({})
    const why = (await (
      await setup(noAuth(), config, agentAnalyzers).request(`/api/jobs/${running.id}/why`)
    ).json()) as JobWhy
    expect(why.costCapUsd).toBe(0.5)
  })

  test('lists the jobs that produced an analysis, only when the caller may read them', async () => {
    const mine = await enqueueChangelog('games/a')
    await store.jobs.claim('w1', '2026-10-30T10:00:00.000Z')
    await store.jobs.complete(mine.id, { at: '2026-10-30T10:01:00.000Z', analysisId: 'a-1' })
    const theirs = await enqueueChangelog('tools/x')
    await store.jobs.claim('w1', '2026-10-30T10:02:00.000Z')
    await store.jobs.complete(theirs.id, { at: '2026-10-30T10:03:00.000Z', analysisId: 'a-2' })
    await enqueueChangelog('games/b')
    const list = async (path: string) =>
      ((await (await setup(games).request(path, { headers: asGames })).json()) as JobList).jobs
    expect((await list('/api/jobs?analysisId=a-1')).map((job) => job.id)).toEqual([mine.id])
    expect(await list('/api/jobs?analysisId=a-2')).toEqual([])
    const count = (await (
      await setup(games).request('/api/jobs/count?analysisId=a-1', { headers: asGames })
    ).json()) as JobCountView
    expect(count.byStatus.succeeded).toBe(1)
  })

  test('checks analyses permissions on the repository', async () => {
    const tools = await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'tools/x' },
      trigger: 'schedule',
      createdAt: '2026-10-30T10:00:00.000Z',
    })
    await store.jobs.enqueue({
      analyzer: 'changelog',
      repo: { forge: 'work', path: 'games/a' },
      trigger: 'schedule',
      createdAt: '2026-10-30T11:00:00.000Z',
    })
    const app = setup(games)

    const list = (await (await app.request('/api/jobs', { headers: asGames })).json()) as JobList
    expect(list.jobs.map((j) => j.repo.path)).toEqual(['games/a'])
    expect((await app.request(`/api/jobs/${tools.id}`, { headers: asGames })).status).toBe(403)
    expect((await app.request('/api/jobs')).status).toBe(401)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/jobs',
          { analyzer: 'changelog', repo: 'work:tools/x' },
          asGames,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await send(
          app,
          'POST',
          '/api/jobs',
          { analyzer: 'changelog', repo: 'work:games/a' },
          asReader,
        )
      ).status,
    ).toBe(403)
    expect(
      (await send(app, 'POST', '/api/jobs', { analyzer: 'fleet', group: 'games' }, asGames)).status,
    ).toBe(201)
  })
})

describe('analyzers', () => {
  test('lists analyzers with JSON Schema options', async () => {
    const list = (await (await setup().request('/api/jobs/analyzers')).json()) as JobAnalyzerList
    expect(list.analyzers.map(({ kind, label, scope }) => ({ kind, label, scope }))).toEqual([
      { kind: 'changelog', label: 'changelog', scope: 'repo' },
      { kind: 'fleet', label: 'fleet', scope: 'group' },
    ])
    expect(list.analyzers[0]?.schema).toMatchObject({ properties: { from: { type: 'string' } } })
  })
})

const tagPush = (path: string, tag: string, after = 'a'.repeat(40)) => ({
  object_kind: 'tag_push',
  ref: `refs/tags/${tag}`,
  after,
  project: { path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
})
const branchPush = (path: string, branch: string, after = 'c'.repeat(40)) => ({
  object_kind: 'push',
  ref: `refs/heads/${branch}`,
  after,
  user_username: 'jane',
  project: { path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
})
const hook = (
  app: ReturnType<typeof setup>,
  body: unknown,
  token = 'hook-secret',
  event = 'Tag Push Hook',
) =>
  send(app, 'POST', '/api/webhooks/gitlab', body, {
    'x-gitlab-token': token,
    'x-gitlab-event': event,
  })

const ignored = async (response: Response) => {
  expect(response.status).toBe(200)
  return ((await response.json()) as { ignored: string }).ignored
}

describe('gitlab webhook', () => {
  test('queues onTag analyzers for the tagged repository, leaving out ones the server lacks', async () => {
    const app = setup(games)
    const response = await hook(app, tagPush('games/a', 'v2.0.0'))
    expect(response.status).toBe(202)
    const jobs = await store.jobs.list()
    expect(
      jobs.map((j) => `${j.analyzer} ${j.repo.path} ${j.ref ?? '-'} ${j.trigger}`).toSorted(),
    ).toEqual(['changelog games/a v2.0.0 tag', 'fleet games - tag'])

    await hook(app, tagPush('games/a', 'v2.0.0'))
    expect(await store.jobs.list()).toHaveLength(2)
    expect(await store.audit.count({ action: 'job' })).toBe(0)
  })

  test('queues one job per commit for monorepo package tags', async () => {
    const app = setup(games)
    const sha = 'b'.repeat(40)
    await hook(app, tagPush('games/a', '@games/card@0.7.0', sha))
    await hook(app, tagPush('games/a', '@games/common@1.4.0', sha))
    const jobs = await store.jobs.list({ analyzer: 'changelog' })
    expect(jobs.map((job) => job.ref)).toEqual([sha])
  })

  test('verifies the token', async () => {
    const app = setup()
    expect((await hook(app, tagPush('games/a', 'v1'), 'wrong')).status).toBe(401)
    expect((await send(app, 'POST', '/api/webhooks/gitlab', tagPush('games/a', 'v1'))).status).toBe(
      401,
    )
    expect(await store.jobs.list()).toEqual([])
    const disabled = setup(noAuth(), parseConfig(baseConfig))
    expect((await hook(disabled, tagPush('games/a', 'v1'))).status).toBe(404)
  })

  test('ignores unconfigured pushes, deleted tags and repositories outside onTag groups', async () => {
    const app = setup()
    expect(
      await ignored(await hook(app, branchPush('games/a', 'main'), 'hook-secret', 'Push Hook')),
    ).toContain('onPush')
    expect(await ignored(await hook(app, tagPush('games/a', 'v1', '0'.repeat(40))))).toContain(
      'deleted',
    )
    expect(await ignored(await hook(app, tagPush('tools/x', 'v1')))).toContain('onTag.groups')
    expect((await hook(app, { object_kind: 'tag_push' })).status).toBe(400)
    expect(await store.jobs.list()).toEqual([])
  })
})

const push = (app: ReturnType<typeof setup>, branch: string, after?: string) =>
  hook(app, branchPush('games/a', branch, after), 'hook-secret', 'Push Hook')

describe('branch push webhook', () => {
  const withPush = parseConfig({
    ...baseConfig,
    jobs: {
      onPush: { analyzers: ['changelog', 'fleet'], branches: ['main', 'release/*'] },
      webhookSecret: 'hook-secret',
    },
  })

  test('queues repo analyzers for matching branches with the commit and branch', async () => {
    const app = setup(noAuth(), withPush)
    expect((await push(app, 'release/1.2')).status).toBe(202)
    const jobs = await store.jobs.list()
    expect(jobs.map((j) => [j.analyzer, j.ref, j.options, j.trigger])).toEqual([
      ['changelog', 'c'.repeat(40), { branch: 'release/1.2' }, 'push'],
    ])
    expect(await store.audit.count({ action: 'job' })).toBe(0)
  })

  test('a newer push cancels the queued job of the same branch', async () => {
    const app = setup(noAuth(), withPush)
    await push(app, 'main', 'd'.repeat(40))
    await push(app, 'main', 'e'.repeat(40))
    const jobs = await store.jobs.list()
    expect(jobs.map((j) => `${j.ref?.[0]} ${j.status}`).toSorted()).toEqual([
      'd canceled',
      'e queued',
    ])
  })

  test('leaves out analyzers that read only the default branch', async () => {
    const app = setup(
      noAuth(),
      parseConfig({
        ...baseConfig,
        jobs: {
          onPush: { analyzers: ['changelog', 'notes'], branches: ['main'] },
          onTag: { analyzers: ['notes'] },
          webhookSecret: 'hook-secret',
        },
      }),
      [
        ...analyzers,
        { kind: 'notes', scope: 'repo', options: z.object({}), defaultBranchOnly: true },
      ],
    )
    expect((await push(app, 'main')).status).toBe(202)
    await hook(app, tagPush('games/a', 'v3.0.0'))
    expect((await store.jobs.list()).map((job) => job.analyzer)).toEqual(['changelog'])
  })

  test('ignores other branches, deleted branches and tags', async () => {
    const app = setup(noAuth(), withPush)
    expect(await ignored(await push(app, 'feature/x'))).toContain('onPush.branches')
    expect(await ignored(await push(app, 'main', '0'.repeat(40)))).toContain('deleted')
    expect(
      await ignored(
        await hook(
          app,
          { ...branchPush('games/a', 'x'), ref: 'refs/tags/v1' },
          'hook-secret',
          'Push Hook',
        ),
      ),
    ).toContain('not to a branch')
    expect(await store.jobs.list()).toEqual([])
  })
})

const dependencyPush = (
  branch: string,
  commits: { added?: string[]; modified?: string[]; removed?: string[] }[],
  extra: Record<string, unknown> = {},
) => ({
  ...branchPush('games/a', branch),
  before: 'b'.repeat(40),
  project: {
    path_with_namespace: 'games/a',
    web_url: 'https://gitlab.test/games/a',
    default_branch: 'main',
  },
  commits,
  total_commits_count: commits.length,
  ...extra,
})
const pushHook = (app: ReturnType<typeof setup>, body: unknown) =>
  hook(app, body, 'hook-secret', 'Push Hook')

describe('default-branch push and freshness', () => {
  test('a push to the default branch records the head for freshness and queues nothing', async () => {
    const app = setup(noAuth(), config)
    await pushHook(app, dependencyPush('main', [{ modified: ['bun.lock'] }]))
    expect(await store.jobs.list()).toEqual([])
    expect(await store.kv?.get('freshness:head:work:games/a')).toMatchObject({
      sha: 'c'.repeat(40),
    })
  })

  test('pushes to other branches leave the head alone', async () => {
    const app = setup(noAuth(), config)
    await pushHook(app, dependencyPush('feature/x', [{ modified: ['package.json'] }]))
    expect(await store.kv?.get('freshness:head:work:games/a')).toBeUndefined()
  })
})
