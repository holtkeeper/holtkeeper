import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type {
  ReleaseGateError,
  ReleaseOverview,
  ReleaseRepoView,
  ReleaseStepResult,
  ReleaseTimelineView,
  ReleaseVersionDetailView,
} from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { createIdentities } from '@holtkeeper/identities'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'
import { createEventDispatcher } from '../src/events.ts'

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['releases:read', 'releases:run', 'settings:write'] }],
    viewer: [{ scope: { all: true }, actions: ['releases:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }

let fake: FakeForge
let store: Store
let deps: Parameters<typeof createApp>[0]
let app: ReturnType<typeof createApp>
let background: Promise<unknown>[]

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [ABC-2] gadgets', 'fix: [ABC-3] crash')
  background = []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  const config = parseConfig({
    forges: {
      work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge },
    },
    groups: { games: { forge: 'work', include: ['g/app'] } },
  })
  deps = {
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      vault,
    }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    releaseRefreshDelayMs: 0,
    onBackground: (work) => {
      background.push(work)
    },
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

const repo = 'work:g/app'

const viewOf = async (headers = asAdmin) =>
  (await (
    await call('GET', `/releases/repo?repo=${repo}`, undefined, headers)
  ).json()) as ReleaseRepoView

const run = async (path: string, body: unknown) => {
  const response = await call('POST', path, body)
  return {
    status: response.status,
    body: (await response.json()) as ReleaseStepResult & ReleaseGateError,
  }
}

const overviewOf = async (query = '', headers = asAdmin) =>
  (await (
    await call('GET', `/releases/overview${query}`, undefined, headers)
  ).json()) as ReleaseOverview

const getJson = async <T>(path: string) => (await (await call('GET', path)).json()) as T

describe('release assistant routes', () => {
  test('shows the overview and the plans of a repository', async () => {
    const overview = await overviewOf()
    expect(overview.cards).toEqual([
      expect.objectContaining({ stage: 'candidate', next: '1.1.0', ahead: 2, needsAction: true }),
    ])

    const view = await viewOf()
    expect(view.proposal?.title).toBe('Release candidate 2026-11-01')
    expect(view.version).toBeUndefined()
    expect(view.can).toEqual({ run: true, configure: true })
    expect(view.detection?.mode).toBe('trunk')

    expect((await viewOf(asViewer)).can.run).toBe(false)
    expect((await call('POST', '/releases/propose', { repo }, asViewer)).status).toBe(403)
  })

  test('serves the overview from a snapshot and rereads it after forge events', async () => {
    expect((await overviewOf()).cards[0]).toMatchObject({ ahead: 2 })

    fake.commitTo('development', 'feat: [ABC-4] settings')
    const reads = fake.listedCommits
    expect((await overviewOf()).cards[0]).toMatchObject({ ahead: 2 })
    expect(fake.listedCommits).toBe(reads)

    await createEventDispatcher(deps)(
      {
        kind: 'push',
        repo: { forge: 'work', path: 'g/app' },
        branch: 'development',
        sha: fake.branches.get('development')!,
        actor: 'dev',
      },
      { actor: 'webhook:gitlab', via: 'webhook' },
    )
    await Promise.all(background)
    expect((await overviewOf()).cards[0]).toMatchObject({ ahead: 3 })

    expect((await overviewOf('?refresh=1')).refreshing).toBe(true)
    await Promise.all(background)
    expect((await overviewOf()).refreshing).toBe(false)
  })

  test('lists only repositories with releases on, filtered by need of action', async () => {
    await store.settings.put({
      id: 'releases',
      key: 'releases',
      scope: { all: true },
      value: {},
      secret: false,
      updatedAt: '2026-10-03T00:00:00.000Z',
    })
    const reads = fake.listedCommits
    expect((await overviewOf()).cards).toEqual([])
    expect(fake.listedCommits).toBe(reads)

    await store.settings.put({
      id: 'releases',
      key: 'releases',
      scope: { all: true },
      value: { enabled: true, flow: { mode: 'external' } },
      secret: false,
      updatedAt: '2026-10-04T00:00:00.000Z',
    })
    await overviewOf('?refresh=1')
    await Promise.all(background)
    expect((await overviewOf()).cards.map((card) => card.needsAction)).toEqual([false])
    expect((await overviewOf('?filter=action')).cards).toEqual([])
    expect((await call('GET', '/releases/overview?filter=some')).status).toBe(400)
    expect(
      (await overviewOf('', { 'x-forwarded-user': 'eve', 'x-forwarded-groups': '' })).cards,
    ).toEqual([])
  })

  test('keeps working with a stored setting of an older shape', async () => {
    await store.settings.put({
      id: 'releases',
      key: 'releases',
      scope: { all: true },
      value: {
        enabled: true,
        acceptance: { required: true, signals: ['label'] },
        summary: { mode: 'agent', audience: 'qa' },
        gates: { pipeline: 'success', freeze: [] },
        timezone: 'Europe/Berlin',
      },
      secret: false,
      updatedAt: '2026-10-03T00:00:00.000Z',
    })
    const view = await viewOf()
    expect(view.settings.acceptance).toBe('none')
    expect(view.row.stage).toBe('candidate')
  })

  test('pages the version timeline and details one version', async () => {
    fake.commitTo('main', 'fix: [ABC-5] keep the counter')
    fake.tag('v1.0.1')
    const first = await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}&limit=1`)
    expect(first).toMatchObject({
      enabled: true,
      total: 2,
      nextOffset: 1,
      next: expect.objectContaining({ stage: 'candidate' }),
      versions: [
        expect.objectContaining({ tag: 'v1.0.1', previous: 'v1.0.0', tickets: ['ABC-5'] }),
      ],
    })
    const reads = fake.listedCommits
    const second = await getJson<ReleaseTimelineView>(
      `/releases/timeline?repo=${repo}&offset=1&limit=1`,
    )
    expect(second.next).toBeUndefined()
    expect(second.versions.map((entry) => [entry.tag, entry.commitCount])).toEqual([['v1.0.0', 2]])
    await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}&limit=1`)
    expect(fake.listedCommits).toBe(reads + 1)

    const detail = await getJson<ReleaseVersionDetailView>(
      `/releases/version?repo=${repo}&tag=v1.0.1`,
    )
    expect(detail).toMatchObject({ tag: 'v1.0.1', bump: 'patch', deploys: [] })
    expect(detail.changelog).toContain('### Fixes')
    expect(detail.tasks.map((task) => task.key)).toEqual(['ABC-5'])
    expect((await call('GET', `/releases/version?repo=${repo}&tag=nope`)).status).toBe(404)
    expect((await call('GET', `/releases/timeline?repo=${repo}&limit=99`)).status).toBe(400)
    expect(
      (
        await call('GET', `/releases/timeline?repo=${repo}`, undefined, {
          'x-forwarded-user': 'eve',
          'x-forwarded-groups': '',
        })
      ).status,
    ).toBe(403)
  })

  test('the timeline pages past the newest hundred tags', async () => {
    fake.commitTo('main', 'fix: [ABC-5] keep the counter')
    fake.tag('v1.0.1')
    for (let index = 0; index < 130; index++) fake.tag(`nightly-${index}`)
    const limits: (number | undefined)[] = []
    const listTags = fake.forge.listTags!.bind(fake.forge)
    fake.forge.listTags = async (path, query) => {
      limits.push(query?.limit)
      return listTags(path, query)
    }
    const first = await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}&limit=1`)
    expect(first.total).toBe(2)
    expect(first.versions).toEqual([
      expect.objectContaining({ tag: 'v1.0.1', previous: 'v1.0.0', tickets: ['ABC-5'] }),
    ])
    expect(limits).toContain(200)
    const reads = limits.length
    const detail = await getJson<ReleaseVersionDetailView>(
      `/releases/version?repo=${repo}&tag=v1.0.0`,
    )
    expect(detail).toMatchObject({ tag: 'v1.0.0', commitCount: 2 })
    expect(detail.previous).toBeUndefined()
    expect(limits).toHaveLength(reads)
  })

  test('maintenance tags dated after a version do not end the tag paging early', async () => {
    fake.commitTo('main', 'feat: add the dial')
    fake.tag('v1.1.0')
    for (let index = 0; index < 130; index++) fake.tag(`nightly-${index}`)
    fake.commitTo('main', 'feat: add the knob')
    fake.tag('v2.0.0')
    fake.commitTo('main', 'fix: dial backport')
    fake.tag('v1.0.5')
    fake.commitTo('main', 'fix: knob backport')
    fake.tag('v1.0.6')
    const limits: (number | undefined)[] = []
    const listTags = fake.forge.listTags!.bind(fake.forge)
    fake.forge.listTags = async (path, query) => {
      limits.push(query?.limit)
      return listTags(path, query)
    }
    const first = await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}&limit=1`)
    expect(first.versions).toEqual([expect.objectContaining({ tag: 'v2.0.0', previous: 'v1.1.0' })])
    expect(limits.slice(0, 2)).toEqual([100, 200])
  })

  test('a tag event drops the cached tag list', async () => {
    await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}`)
    fake.commitTo('main', 'fix: later')
    fake.tag('v1.0.1')
    expect((await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}`)).total).toBe(1)
    await createEventDispatcher(deps)(
      {
        kind: 'tag',
        repo: { forge: 'work', path: 'g/app' },
        tag: 'v1.0.1',
        sha: fake.branches.get('main')!,
      },
      { actor: 'webhook:gitlab', via: 'webhook' },
    )
    await Promise.all(background)
    expect((await getJson<ReleaseTimelineView>(`/releases/timeline?repo=${repo}`)).total).toBe(2)
  })

  test('writes the notes with the AI agent at propose time when asked', async () => {
    const tasks: { taskKind?: string; tier?: string }[] = []
    deps.agentFor = async () => ({
      name: 'fake',
      run: async (task) => {
        tasks.push({ taskKind: task.taskKind, tier: task.tier })
        return {
          text: '',
          turns: 1,
          output: { overview: 'Gadgets arrive.', highlights: ['A gadgets panel'], check: [] },
        } as never
      },
    })
    app = createApp(deps)
    const proposed = await run('/releases/propose', { repo, writeNotes: true })
    expect(proposed.body).toMatchObject({ kind: 'proposed' })
    expect(tasks).toEqual([{ taskKind: 'release-notes', tier: 'fast' }])
    expect(fake.requests[0]?.description).toContain('Gadgets arrive.')

    await run('/releases/propose', { repo })
    expect(tasks).toHaveLength(1)
  })

  test('proposes, accepts after the merge and creates the version with edits', async () => {
    const proposed = await run('/releases/propose', { repo })
    expect(proposed.body).toMatchObject({ kind: 'proposed', url: 'https://forge/mr/1' })

    fake.merge('development', 'main')
    const dispatch = createEventDispatcher(deps)
    await dispatch(
      {
        kind: 'mergeRequest',
        repo: { forge: 'work', path: 'g/app' },
        action: 'merge',
        actor: 'lead',
        newCommits: false,
        leftDraft: false,
        labelsAdded: [],
        mr: { ...fake.requests[0]!, state: 'merged' },
      },
      { actor: 'webhook:gitlab', via: 'webhook' },
    )
    await Promise.all(background)

    const refused = await run('/releases/version', { repo })
    expect(refused.status).toBe(409)
    expect(refused.body.gates?.map((gate) => gate.id)).toEqual(['acceptance'])

    let view = await viewOf()
    const fix = view.version!.entries.find((entry) => entry.text === 'crash')!
    expect(
      (
        await call('PUT', '/releases/edits', {
          repo,
          step: 'version',
          edits: { version: '2.0.0', texts: { [fix.id]: 'No more crash on load' } },
        })
      ).status,
    ).toBe(200)

    expect((await call('POST', '/releases/accept', { repo, note: 'QA passed' })).status).toBe(200)
    view = await viewOf()
    expect(view.row.acceptance).toMatchObject({
      by: 'header:jane',
      name: 'jane',
      via: 'manual',
      channel: 'api',
    })
    expect(view.history[0]).toMatchObject({
      kind: 'accepted',
      actor: 'header:jane',
      actorName: 'jane',
      channel: 'api',
    })
    expect(view.links).toContainEqual(
      expect.objectContaining({ kind: 'merge-request', label: 'Merged !1' }),
    )
    expect(view.version?.tag).toBe('v2.0.0')

    const versioned = await run('/releases/version', { repo })
    expect(versioned.body).toMatchObject({ kind: 'versioned', tag: 'v2.0.0' })
    expect(fake.releases.get('v2.0.0')?.description).toContain('No more crash on load')

    view = await viewOf()
    expect(view.row.stage).toBe('released')
    expect(view.history.map((event) => event.kind)).toEqual([
      'versioned',
      'accepted',
      'merged',
      'proposed',
    ])
    const audited = (await store.audit.list({ action: 'release.versioned' })).events
    expect(audited[0]?.target).toEqual({ type: 'release', repo: 'work:g/app' })
  })

  test('follows a started deploy until it fails', async () => {
    await store.settings.put({
      id: 'releases-deploy',
      key: 'releases',
      scope: { repos: ['g/app'] },
      value: {
        enabled: true,
        acceptance: 'manual',
        deploy: { environments: [{ name: 'preprod', job: 'deploy:preprod' }] },
      },
      secret: false,
      updatedAt: '2026-10-02T00:00:00.000Z',
    })
    fake.addPipeline('v1.0.0', 'manual', [{ name: 'deploy:preprod', status: 'manual' }])
    const started = await run('/releases/deploy', {
      repo,
      tag: 'v1.0.0',
      environment: 'preprod',
    })
    expect(started.body).toMatchObject({ kind: 'deploy-started', tag: 'v1.0.0' })
    fake.jobs.get(1)![0]!.status = 'failed'
    await Promise.all(background)
    const view = await viewOf()
    expect(view.deploy?.environments[0]?.status).toBe('failed')
    expect(view.history.map((event) => [event.kind, event.environment])).toEqual([
      ['deploy-failed', 'preprod'],
      ['deploy-started', 'preprod'],
    ])
  })
})

const linkJane = async () => {
  const accounts = store.externalAccounts
  if (!accounts) throw new Error('the memory store keeps external accounts')
  const identities = createIdentities({ accounts, now: () => new Date() })
  const jane: Principal = {
    id: 'jane',
    name: 'jane',
    provider: 'header',
    grants: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }],
  }
  const linked = await identities.link(jane, { provider: 'gitlab:work', externalId: '5' })
  const { code } = await identities.issueChallenge(jane, linked.id)
  await identities.completeChallenge({ provider: 'gitlab:work', externalId: '5', code })
}

const say = (body: string) =>
  createEventDispatcher(deps)(
    {
      kind: 'note',
      repo: { forge: 'work', path: 'g/app' },
      mergeRequest: 3,
      mergeRequestState: 'open',
      author: 'jane',
      authorId: '5',
      body,
      inThread: false,
    },
    { actor: 'webhook:gitlab', via: 'webhook' },
  )

const lastNote = () => [...fake.notes.values()].at(-1)?.body ?? ''

describe('release chat command', () => {
  test('shows the state with the next steps as commands', async () => {
    await linkJane()
    expect(await say('/holtkeeper release')).toEqual({ enqueued: [] })
    expect(lastNote()).toContain('#### 🔵 Release · g/app')
    expect(lastNote()).toContain('✅ Changes → 🔵 Candidate → ⚪ Version → ⚪ Deploy')
    expect(lastNote()).toContain('<sub>Changes wait for a release candidate</sub>')
    expect(lastNote()).toContain('- **Next:** `1.1.0` (minor)')
    expect(lastNote()).toContain('`/holtkeeper release propose` — Open the release candidate')
  })

  test('asks before deploying, then follows the deploy in one note', async () => {
    await store.settings.put({
      id: 'releases-deploy',
      key: 'releases',
      scope: { repos: ['g/app'] },
      value: {
        enabled: true,
        acceptance: 'manual',
        deploy: { environments: [{ name: 'preprod', job: 'deploy:preprod' }] },
      },
      secret: false,
      updatedAt: '2026-10-02T00:00:00.000Z',
    })
    fake.addPipeline('v1.0.0', 'manual', [{ name: 'deploy:preprod', status: 'manual' }])
    await linkJane()

    await say('/holtkeeper release deploy preprod')
    expect(lastNote()).toContain('Deploy v1.0.0 of g/app to preprod?')
    expect(lastNote()).toContain('`/holtkeeper release deploy preprod tag=v1.0.0 --yes`')
    expect(fake.jobs.get(1)?.[0]?.status).toBe('manual')

    await say('/holtkeeper release deploy preprod tag=v1.0.0 --yes')
    const noteId = fake.notes.size
    expect(fake.notes.get(noteId)?.body).toContain(
      '- 🔄 **preprod** — queued · [View job](https://forge/j/100)',
    )
    fake.jobs.get(1)![0]!.status = 'success'
    await Promise.all(background)
    expect(fake.notes.size).toBe(noteId)
    expect(fake.notes.get(noteId)?.body).toContain('#### 🟢 Deploy v1.0.0 · g/app')
    expect(fake.notes.get(noteId)?.body).toContain(
      '- ✅ **preprod** — deployed · [View job](https://forge/j/100)',
    )
  })
})
