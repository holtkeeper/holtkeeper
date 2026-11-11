import { beforeEach, describe, expect, test } from 'bun:test'

import type { Principal } from '@holtkeeper/access'
import type { ReleaseRepoView, ReleaseVersionDetailView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { Issue } from '@holtkeeper/issues'
import { fakeIssueTracker } from '@holtkeeper/issues/testing'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { registryServer } from '../src/api-surface/mcp.ts'
import { createApp } from '../src/app.ts'
import type { ServerDeps } from '../src/context.ts'
import { agentReleaseAccess, releaseToolsAccess } from '../src/release-steps.ts'
import { releasesToolset } from '../src/tools/releases.ts'

const releaser: Principal = {
  id: 'header:jane',
  name: 'Jane',
  provider: 'header',
  grants: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }],
}
const reader: Principal = {
  id: 'header:bob',
  name: 'Bob',
  provider: 'header',
  grants: [{ scope: { all: true }, actions: ['releases:read'] }],
}

const shapes: Issue = {
  key: 'ABC-5',
  title: 'Round shapes',
  status: 'Done',
  category: 'done',
  type: 'Story',
  url: 'https://tracker.example.com/browse/ABC-5',
}

let fake: FakeForge
let store: Store
let deps: ServerDeps
let tracker: ReturnType<typeof fakeIssueTracker> | undefined

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  fake.commitTo('main', 'feat: [ABC-5] round shapes', 'fix: [ABC-6] square gadgets')
  fake.commitTo('development', 'feat: [ABC-2] gadgets')
  store = memoryStore()
  tracker = undefined
  const vault = aesVault('v'.repeat(32))
  deps = {
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
      groups: {
        games: { forge: 'work', include: ['g/app'] },
        toys: { forge: 'work', include: ['t/kite'] },
      },
    }),
    auth: headerAuth({ roles: {} }),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    releaseRefreshDelayMs: 0,
    issueTracker: async () => tracker,
    onBackground: () => {},
  }
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: { enabled: true, acceptance: 'manual', flow: { mode: 'trunk' } },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
})

async function connect(principal: Principal, steps = false) {
  const access = releaseToolsAccess(deps, {
    principal,
    canRead: (repo) => repo.groups.includes('games'),
    steps,
    channel: 'mcp',
  })
  const server = registryServer([releasesToolset(access)], {
    principal,
    usage: { record: () => {} },
    now: deps.now,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return {
      text: (result.content as { text: string }[])[0]?.text ?? '',
      isError: result.isError === true,
    }
  }
  return { client, call }
}

const repo = 'work:g/app'

describe('releases toolset over MCP', () => {
  test('lists the read tools, and release_step only with steps', async () => {
    const plain = await connect(releaser)
    expect((await plain.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'release_rules',
      'release_status',
      'release_changes',
    ])
    expect(plain.client.getInstructions()).toContain('call release_rules and release_status')
    const stepping = await connect(releaser, true)
    expect((await stepping.client.listTools()).tools.map((tool) => tool.name)).toContain(
      'release_step',
    )
  })

  test('release_rules explains the flow with the Guide releases section', async () => {
    await store.guides.put({
      scope: 'group:games',
      section: 'releases',
      rules: 'Release notes name the shapes that changed.',
      steering: '',
      learnings: [],
    })
    const { call } = await connect(reader)
    const { text } = await call('release_rules', { repo })
    expect(text).toContain('# How `work:g/app` releases')
    expect(text).toContain('Changes land on `the default branch` directly')
    expect(text).toContain('`feat` is minor')
    expect(text).toContain('Acceptance: a person accepts')
    expect(text).toContain('Release notes name the shapes that changed.')
    expect((await call('release_rules', { repo: 'work:t/kite' })).isError).toBe(true)
  })

  test('release_status shows the next version, its reason and the allowed steps', async () => {
    const { call } = await connect(reader)
    const { text } = await call('release_status', { repo })
    expect(text).toContain('Merged changes wait for a version.')
    expect(text).toContain('- Latest: `v1.0.0`')
    expect(text).toContain('- Next: `1.1.0` (minor)')
    expect(text).toContain('Accept the changes (action accept)')
    expect(text).toContain('Create v1.1.0 (action version)')
  })

  test('release_changes lists tasks as plain keys without a tracker', async () => {
    const { call } = await connect(reader)
    const next = await call('release_changes', { repo })
    expect(next.text).toContain('v1.0.0 → main (next release)')
    expect(next.text).toContain('- ABC-5 round shapes (1 commits)')
    expect(next.text).toContain('- ABC-6 square gadgets (1 commits)')
    expect(next.text).not.toContain('ABC-1')

    const first = await call('release_changes', { repo, to: '1.0.0' })
    expect(first.text).toContain('start → v1.0.0')
    expect(first.text).toContain('- ABC-1 first widget')
  })

  test('release_changes finds version tags older than the newest hundred tags', async () => {
    fake.tag('v1.0.1')
    fake.commitTo('main', 'feat: [ABC-7] tall towers')
    for (let index = 0; index < 130; index++) fake.tag(`nightly-${index}`)
    const { call } = await connect(reader)
    const next = await call('release_changes', { repo })
    expect(next.text).toContain('v1.0.1 → main (next release)')
    expect(next.text).toContain('- ABC-7 tall towers')
    const older = await call('release_changes', { repo, to: 'v1.0.1' })
    expect(older.text).toContain('v1.0.0 → v1.0.1')
    expect(older.text).toContain('- ABC-5 round shapes')
  })

  test('release_changes enriches tasks from the tracker and links only with a URL', async () => {
    tracker = fakeIssueTracker([shapes])
    const { call } = await connect(reader)
    const { text } = await call('release_changes', { repo })
    expect(text).toContain(
      '- [ABC-5](https://tracker.example.com/browse/ABC-5) Round shapes [Story, Done] (1 commits)',
    )
    expect(text).toContain('- ABC-6 square gadgets (1 commits)')
    expect(tracker.calls).toEqual([['ABC-6', 'ABC-5']])

    fake.commitTo('feature/kites', 'feat: XYZ-9 private kites')
    const branch = await call('release_changes', { repo, from: 'main', to: 'feature/kites' })
    expect(branch.text).toContain('- XYZ-9 private kites')
    expect(tracker.calls).toEqual([['ABC-6', 'ABC-5']])

    tracker = fakeIssueTracker([], { fail: new Error('401 Unauthorized') })
    expect((await call('release_changes', { repo })).text).toContain('- ABC-5 round shapes')
  })
})

describe('release_step', () => {
  test('previews with a confirm token, runs once with it and records the step', async () => {
    const { call } = await connect(releaser, true)
    const preview = await call('release_step', { repo, action: 'accept', note: 'QA passed' })
    expect(preview.text).toContain('# Accept main of g/app for v1.1.0')
    expect(preview.text).toContain('Nothing has changed yet.')
    const token = /confirm: "([\w-]+)"/u.exec(preview.text)?.[1]
    expect(token).toBeDefined()

    const other = await call('release_step', { repo, action: 'accept', confirm: token })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('Call release_step without confirm to preview again')

    const again = await call('release_step', { repo, action: 'accept', note: 'QA passed' })
    const fresh = /confirm: "([\w-]+)"/u.exec(again.text)?.[1]
    const done = await call('release_step', {
      repo,
      action: 'accept',
      note: 'QA passed',
      confirm: fresh,
    })
    expect(done.isError).toBe(false)
    expect(done.text).toBe('Accepted')
    const reused = await call('release_step', {
      repo,
      action: 'accept',
      note: 'QA passed',
      confirm: fresh,
    })
    expect(reused.isError).toBe(true)

    const accepted = (await store.audit.list({ action: 'release.accepted' })).events
    expect(accepted).toEqual([
      expect.objectContaining({
        via: 'api',
        actor: expect.objectContaining({ id: 'header:jane' }),
        details: expect.objectContaining({ channel: 'mcp', detail: 'QA passed' }),
      }),
    ])
    const denied = (await store.audit.list({ action: 'release.accept' })).events.filter(
      (event) => event.outcome === 'denied',
    )
    expect(denied).toHaveLength(2)
  })

  test('refuses a token once the release state changed', async () => {
    const { call } = await connect(releaser, true)
    const preview = await call('release_step', { repo, action: 'version' })
    expect(preview.text).toContain('# Create v1.1.0 of g/app?')
    expect(preview.text).toContain('Failing gates:')
    const token = /confirm: "([\w-]+)"/u.exec(preview.text)?.[1]
    fake.commitTo('main', 'feat: [ABC-7] more shapes')
    const result = await call('release_step', { repo, action: 'version', confirm: token })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('changed since the preview')
    expect(fake.tags.map((tag) => tag.name)).toEqual(['v1.0.0'])
  })

  test('blocks steps the state does not allow and callers without releases:run', async () => {
    const { call } = await connect(releaser, true)
    const blocked = await call('release_step', { repo, action: 'propose' })
    expect(blocked.text).toContain('Blocked: The flow has no release candidate merge request.')
    expect(blocked.text).not.toContain('confirm:')
    const deploy = await call('release_step', { repo, action: 'deploy', environment: 'prod' })
    expect(deploy.text).toContain('Blocked: No environment prod; configured: none.')

    const limited = await connect(reader, true)
    const refused = await limited.call('release_step', { repo, action: 'accept' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toBe('You may not run release steps of work:g/app.')
    const denied = (await store.audit.list({ action: 'release.accept' })).events
    expect(denied).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        actor: expect.objectContaining({ id: 'header:bob' }),
        details: expect.objectContaining({ reason: 'missing releases:run' }),
      }),
    ])
  })

  test('runs a token once when two calls redeem it at the same time', async () => {
    const { call } = await connect(releaser, true)
    const preview = await call('release_step', { repo, action: 'accept' })
    const token = /confirm: "([\w-]+)"/u.exec(preview.text)?.[1]
    const results = await Promise.all([
      call('release_step', { repo, action: 'accept', confirm: token }),
      call('release_step', { repo, action: 'accept', confirm: token }),
    ])
    expect(results.filter((result) => result.isError)).toHaveLength(1)
    expect((await store.audit.list({ action: 'release.accepted' })).events).toHaveLength(1)
  })
})

describe('internal agents', () => {
  test('read releases of their repository and its group, without steps', async () => {
    const access = agentReleaseAccess(deps, { forge: 'work', path: 'g/app', groups: ['games'] })
    expect(access.steps).toBeUndefined()
    expect(access.repoOf('work:g/app')).toEqual({ forge: 'work', path: 'g/app' })
    expect(access.repoOf('work:t/kite')).toBeUndefined()
    expect(releasesToolset(access).tools.map((tool) => tool.name)).toEqual([
      'release_rules',
      'release_status',
      'release_changes',
    ])
    expect(access.anonymous).toBe(true)
    const asker: Principal = {
      id: 'header:kim',
      name: 'Kim',
      provider: 'header',
      grants: [{ scope: { repos: ['work:t/kite'] }, actions: ['releases:read'] }],
    }
    const narrowed = agentReleaseAccess(
      deps,
      { forge: 'work', path: 'g/app', groups: ['games'] },
      asker,
    )
    expect(narrowed.repoOf('work:g/app')).toBeUndefined()
  })
})

describe('tracker issues on release pages', () => {
  const auth = headerAuth({
    roles: { admin: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }] },
  })
  const headers = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
  const get = async <T>(path: string) => {
    const app = createApp({ ...deps, auth })
    return (await (await app.request(`/api${path}`, { headers })).json()) as T
  }

  test('adds issues to the repository view and version tasks when a tracker answers', async () => {
    tracker = fakeIssueTracker([shapes, { key: 'ABC-1', title: 'First widget' }])
    const view = await get<ReleaseRepoView>(`/releases/repo?repo=${repo}`)
    expect(view.issues).toEqual({ 'ABC-5': shapes })
    const version = await get<ReleaseVersionDetailView>(`/releases/version?repo=${repo}&tag=v1.0.0`)
    expect(version.tasks).toEqual([
      expect.objectContaining({ key: 'ABC-1', issue: { key: 'ABC-1', title: 'First widget' } }),
    ])
  })

  test('keeps plain keys without a tracker or when it fails', async () => {
    const plain = await get<ReleaseRepoView>(`/releases/repo?repo=${repo}`)
    expect(plain.issues).toBeUndefined()
    tracker = fakeIssueTracker([], { fail: new Error('timeout') })
    const failing = await get<ReleaseVersionDetailView>(`/releases/version?repo=${repo}&tag=v1.0.0`)
    expect(failing.tasks).toEqual([expect.objectContaining({ key: 'ABC-1' })])
    expect(failing.tasks[0]?.issue).toBeUndefined()
  })
})
