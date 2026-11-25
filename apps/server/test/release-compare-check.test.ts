import { beforeEach, describe, expect, test } from 'bun:test'

import type { ReleaseCompareCheck, ReleaseCompareCheckStart } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { DiffFile } from '@holtkeeper/forge'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import {
  type UpgradeCheckData,
  upgradeCheckAnalyzer,
  upgradeCheckRef,
} from '@holtkeeper/upgrade-check'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { releaseComparer } from '../src/env-compare.ts'
import { automaticSkip } from '../src/jobs.ts'
import { renderApiChanges, upgradeCheckInputs } from '../src/upgrade-check.ts'

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['releases:read', 'releases:run', 'analyses:run'] }],
    viewer: [{ scope: { all: true }, actions: ['releases:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }
const asNobody = { 'x-forwarded-user': 'eve', 'x-forwarded-groups': '' }

const repo = 'work:g/app'
const repoRef = { forge: 'work', path: 'g/app' }

const manifest = (deps: Record<string, string>) =>
  JSON.stringify({ name: 'demo', dependencies: deps })

let fake: FakeForge
let store: Store
let deps: Parameters<typeof createApp>[0]
let app: ReturnType<typeof createApp>
let first: string
let second: string
let head: string

const changedFiles: DiffFile[] = [
  { oldPath: 'package.json', newPath: 'package.json', status: 'modified', diff: '@@ -1 +1 @@' },
]

const result = (from: string, to: string): UpgradeCheckData => ({
  from: { ref: from, sha: from, label: 'v1.0.0' },
  to: { ref: to, sha: to, label: 'v1.1.0' },
  verdict: 'review',
  summary: 'Dials change their default.',
  areas: [{ name: 'Dials', files: 1, summary: 'New default.' }],
  findings: [
    {
      id: 'f1',
      severity: 'risky',
      category: 'behavior',
      title: 'Dial default changes',
      detail: 'Dials start at 1 instead of 0.',
      files: [{ path: 'src/dial.ts', line: 1 }],
      check: 'Turn a fresh dial and read its value.',
    },
  ],
  skipped: [],
  capped: false,
})

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  first = fake.branches.get('main')!
  fake.commitTo('main', 'feat: [ABC-7] add dials')
  fake.tag('v1.1.0')
  second = fake.branches.get('main')!
  head = fake.commitTo('main', 'feat: [ABC-9] spin the dial')
  const filesAt = new Map([
    [first, { 'package.json': manifest({ 'some-lib': '^1.0.0' }) }],
    [second, { 'package.json': manifest({ 'some-lib': '^1.0.0', 'widget-kit': '^2.0.0' }) }],
  ])
  fake.forge.readFile = async (_repo, file, ref) =>
    ref ? (filesAt.get(ref) as Record<string, string> | undefined)?.[file] : undefined
  fake.forge.compareCommits = async (_repo, from, to) =>
    from === first && to === second ? changedFiles : []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  deps = {
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    analyzers: [upgradeCheckAnalyzer],
    agentFor: async () => ({ name: 'fake', run: async () => ({ text: '', turns: 1 }) }),
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    releaseRefreshDelayMs: 0,
    onBackground: () => {},
  }
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: { enabled: true, acceptance: 'manual' },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  app = createApp(deps)
})

const call = (method: string, path: string, body?: unknown, headers = asAdmin) =>
  app.request(`/api${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const status = async (query = 'from=v1.0.0&to=v1.1.0', headers = asAdmin) => {
  const response = await call(
    'GET',
    `/releases/compare/check?repo=${repo}&${query}`,
    undefined,
    headers,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as ReleaseCompareCheck
}

const start = async (body: Record<string, unknown> = {}) => {
  const response = await call('POST', '/releases/compare/check', {
    repo,
    from: 'v1.0.0',
    to: 'v1.1.0',
    ...body,
  })
  expect(response.status).toBe(200)
  return (await response.json()) as ReleaseCompareCheckStart
}

const finish = async (jobId: string) => {
  const at = '2026-11-01T09:05:00.000Z'
  await store.jobs.claim('w1', '2026-11-01T09:01:00.000Z')
  const record = await store.analyses.add({
    repo: repoRef,
    kind: 'upgrade-check',
    ref: upgradeCheckRef(first, second),
    sha: second,
    createdAt: at,
    data: result(first, second),
  })
  await store.jobs.complete(jobId, { at, analysisId: record.id })
  return record.id
}

describe('breaking-change check routes', () => {
  test('needs releases:read to read and releases:run to start', async () => {
    const query = `/releases/compare/check?repo=${repo}&from=v1.0.0&to=v1.1.0`
    expect((await call('GET', query, undefined, asNobody)).status).toBe(403)
    expect((await status(undefined, asViewer)).status).toBe('none')
    const refused = await call('POST', '/releases/compare/check', { repo }, asViewer)
    expect(refused.status).toBe(403)
    expect((await call('GET', '/releases/compare/check')).status).toBe(400)
  })

  test('queues one manual single-attempt job per range, at the to commit', async () => {
    const { jobId, existing } = await start()
    expect(existing).toBeUndefined()
    const job = await store.jobs.get(jobId!)
    expect(job).toMatchObject({
      analyzer: 'upgrade-check',
      repo: repoRef,
      ref: second,
      trigger: 'manual',
      maxAttempts: 1,
      actor: 'header:jane',
      options: { from: first, to: second, fromLabel: 'v1.0.0', toLabel: 'v1.1.0' },
    })
    expect((await start()).jobId).toBe(jobId)
    expect(await store.jobs.list({ analyzer: 'upgrade-check' })).toHaveLength(1)
    expect(await status()).toEqual({ status: 'queued', jobId: jobId! })
    await store.jobs.claim('w1', '2026-11-01T09:01:00.000Z')
    expect(await status()).toEqual({ status: 'running', jobId: jobId! })
  })

  test('the target branch end is its head commit now', async () => {
    const { jobId } = await start({ from: 'v1.1.0', to: undefined })
    const job = await store.jobs.get(jobId!)
    expect(job?.ref).toBe(head)
    expect(job?.options).toMatchObject({ from: second, to: head, toLabel: 'main' })
  })

  test('answers a finished check instead of queueing again, unless forced', async () => {
    const { jobId } = await start()
    const analysisId = await finish(jobId!)
    const done = await status()
    expect(done).toMatchObject({ status: 'done', analysisId })
    expect(done.data?.verdict).toBe('review')
    expect(done.data?.findings[0]?.title).toBe('Dial default changes')
    expect(await start()).toEqual({ existing: analysisId, jobId: jobId! })
    const forced = await start({ force: true })
    expect(forced.existing).toBeUndefined()
    expect(forced.jobId).not.toBe(jobId)
    expect(await status()).toEqual({ status: 'queued', jobId: forced.jobId! })
  })

  test('queues the check in the AI language and does not reuse one written in another', async () => {
    const { jobId } = await start()
    expect((await store.jobs.get(jobId!))?.options.language).toBe('English')
    const analysisId = await finish(jobId!)
    await store.settings.put({
      id: 'review',
      key: 'analyzers.review',
      scope: { all: true },
      value: { language: 'Esperanto' },
      secret: false,
      updatedAt: '2026-10-02T00:00:00.000Z',
    })
    expect(await status()).toEqual({ status: 'none' })
    const again = await start()
    expect(again.existing).toBeUndefined()
    expect((await store.jobs.get(again.jobId!))?.options.language).toBe('Esperanto')
    expect(await status()).toEqual({ status: 'queued', jobId: again.jobId! })
    await store.settings.put({
      id: 'review',
      key: 'analyzers.review',
      scope: { all: true },
      value: { language: 'english' },
      secret: false,
      updatedAt: '2026-10-03T00:00:00.000Z',
    })
    expect(await status()).toMatchObject({ status: 'done', analysisId })
  })

  test('a failed run after a finished one reports the error with the earlier result', async () => {
    const earlier = await start()
    const analysisId = await finish(earlier.jobId!)
    const again = await start({ force: true })
    await store.jobs.claim('w1', '2026-11-01T09:10:00.000Z')
    await store.jobs.fail(again.jobId!, { at: '2026-11-01T09:11:00.000Z', error: 'out of budget' })
    const failed = await status()
    expect(failed).toMatchObject({
      status: 'failed',
      jobId: again.jobId,
      error: 'out of budget',
      analysisId,
    })
  })

  test('a failed first run reports failed; canceled runs are ignored', async () => {
    const { jobId } = await start()
    await store.jobs.cancel(jobId!, '2026-11-01T09:01:00.000Z')
    expect((await status()).status).toBe('none')
    const next = await start()
    await store.jobs.claim('w1', '2026-11-01T09:02:00.000Z')
    await store.jobs.fail(next.jobId!, { at: '2026-11-01T09:03:00.000Z', error: 'git failed' })
    expect(await status()).toEqual({ status: 'failed', jobId: next.jobId!, error: 'git failed' })
  })

  test('refuses without an agent or without a start', async () => {
    deps.agentFor = async () => undefined
    app = createApp(deps)
    const response = await call('POST', '/releases/compare/check', { repo, from: 'v1.0.0' })
    expect(response.status).toBe(409)
    expect(await store.jobs.list({ analyzer: 'upgrade-check' })).toHaveLength(0)
  })

  test('is never queued through POST /api/jobs or by schedules', async () => {
    const response = await call('POST', '/jobs', {
      analyzer: 'upgrade-check',
      repo,
      options: { from: first, to: second },
    })
    expect(response.status).toBe(400)
    const skip = automaticSkip(store, deps.config, deps.analyzers)
    expect(await skip('upgrade-check', repoRef)).toBe(true)
  })
})

describe('upgrade check inputs', () => {
  test('renders public API changes, missing records and the unrecorded case', () => {
    expect(renderApiChanges({ packages: [], missing: [], recorded: false })).toBeUndefined()
    expect(renderApiChanges({ packages: [], missing: [], recorded: true })).toBe(
      'No export of the repository’s own packages changed.',
    )
    const text = renderApiChanges({
      packages: [{ name: '@acme/dials', from: '1.0.0', to: '2.0.0', markdown: '- removed `spin`' }],
      missing: [{ name: '@acme/knobs', side: 'from' }],
      recorded: true,
    })
    expect(text).toBe(
      '### @acme/dials (1.0.0 → 2.0.0)\n\n- removed `spin`\n\nNot recorded: @acme/knobs (from).',
    )
  })

  test('reads the dependency changes of the range by its labels', async () => {
    const inputs = await upgradeCheckInputs(() => deps)(repoRef, {
      from: { ref: first, sha: first, label: 'v1.0.0' },
      to: { ref: second, sha: second, label: 'v1.1.0' },
    })
    expect(inputs.apiChanges).toBeUndefined()
    expect(inputs.dependencyChanges).toContain('widget-kit')
  })
})

describe('environment comparer', () => {
  const range = { from: 'v1.0.0', to: 'v1.1.0' }

  test('queues the check, waits for it and reports its findings with dependency changes', async () => {
    let polls = 0
    const comparer = releaseComparer(deps, {
      checkPollMs: 1,
      checkWaitMs: 10,
      wait: async () => {
        polls++
        const [job] = await store.jobs.list({ limit: 1 })
        if (polls === 2 && job) await finish(job.id)
      },
    })
    const found = await comparer.compare(repoRef, range)
    expect(found.breaking).toEqual({
      status: 'done',
      items: ['risky: Dial default changes. Check: Turn a fresh dial and read its value.'],
    })
    expect(found.dependencies).toEqual([{ name: 'widget-kit', change: 'added', to: '^2.0.0' }])
    expect(found.tasks.map((task) => task.key)).toEqual(['ABC-7'])
  })

  test('reports a check still running past the wait, and none without an agent', async () => {
    const comparer = releaseComparer(deps, {
      checkPollMs: 1,
      checkWaitMs: 2,
      wait: async () => {},
    })
    expect((await comparer.compare(repoRef, range)).breaking).toEqual({
      status: 'running',
      items: [],
    })
    expect(await store.jobs.list({})).toHaveLength(1)
    deps.agentFor = async () => undefined
    expect((await comparer.compare(repoRef, range)).breaking).toBeUndefined()
  })
})
