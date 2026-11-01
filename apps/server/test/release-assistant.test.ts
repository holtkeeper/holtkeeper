import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  ReleaseBoardView,
  ReleaseGateError,
  ReleaseRepoView,
  ReleaseStepResult,
} from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
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
  fake.commitTo('main', 'feat: [GTW-1] first screen')
  fake.tag('v1.0.0')
  fake.commitTo('development', 'feat: [GTW-2] statistics', 'fix: [GTW-3] crash')
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
      activity: store.activity,
      vault,
    }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    onBackground: (work) => {
      background.push(work)
    },
  }
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: { acceptance: { required: true } },
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

describe('release assistant routes', () => {
  test('shows the board and the plans of a repository', async () => {
    const board = (await (await call('GET', '/releases/board')).json()) as ReleaseBoardView
    expect(board.rows).toEqual([
      expect.objectContaining({ stage: 'candidate', next: '1.1.0', ahead: 2 }),
    ])

    const view = await viewOf()
    expect(view.proposal?.title).toBe('Release candidate 2026-11-01')
    expect(view.version).toBeUndefined()
    expect(view.can).toEqual({ run: true, configure: true })
    expect(view.detection?.preset).toBe('trunk')

    expect((await viewOf(asViewer)).can.run).toBe(false)
    expect((await call('POST', '/releases/propose', { repo }, asViewer)).status).toBe(403)
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
    expect(view.row.acceptance).toMatchObject({ by: 'header:jane', via: 'manual' })
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
    const actions = (await store.activity.list()).map((entry) => entry.action)
    expect(actions).toContain('release.versioned')
  })

  test('follows a started deploy until it fails', async () => {
    await store.settings.put({
      id: 'releases-deploy',
      key: 'releases',
      scope: { repos: ['g/app'] },
      value: { deploy: { environments: [{ name: 'preprod', job: 'deploy:preprod' }] } },
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
