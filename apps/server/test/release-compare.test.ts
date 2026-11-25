import { beforeEach, describe, expect, test } from 'bun:test'

import type { ReleaseCompareRefs, ReleaseCompareSummary, ReleaseCompareView } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import type { DiffFile } from '@holtkeeper/forge'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['releases:read', 'releases:run'] }],
    viewer: [{ scope: { all: true }, actions: ['releases:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }
const asNobody = { 'x-forwarded-user': 'eve', 'x-forwarded-groups': '' }

const repo = 'work:g/app'

const manifest = (deps: Record<string, string>) =>
  JSON.stringify({ name: 'demo', dependencies: deps })
const lock = (deps: Record<string, string>, packages: Record<string, string>) =>
  JSON.stringify({
    name: 'demo',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: deps },
      ...Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [`node_modules/${name}`, { version }]),
      ),
    },
  })

let fake: FakeForge
let store: Store
let deps: Parameters<typeof createApp>[0]
let app: ReturnType<typeof createApp>
let first: string
let second: string
let filesAt: Map<string, Record<string, string>>
let compared: [string, string][]
let reads: string[]

const changedFiles: DiffFile[] = [
  { oldPath: 'package.json', newPath: 'package.json', status: 'modified', diff: '@@ -1 +1 @@' },
  {
    oldPath: 'package-lock.json',
    newPath: 'package-lock.json',
    status: 'modified',
    diff: '@@ -1 +1 @@',
  },
  {
    oldPath: 'src/dial.ts',
    newPath: 'src/dial.ts',
    status: 'added',
    diff: '@@ -0,0 +1 @@\n+export const dial = () => 1',
  },
]

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  first = fake.branches.get('main')!
  fake.commitTo('main', 'feat: [ABC-7] add dials', 'fix: [ABC-8] round knobs')
  fake.tag('v1.1.0')
  second = fake.branches.get('main')!
  fake.commitTo('main', 'feat: [ABC-9] spin the dial')
  fake.commitTo('development', 'feat: [ABC-10] gadget shelf')
  filesAt = new Map([
    [
      first,
      {
        'package.json': manifest({ 'some-lib': '^1.0.0' }),
        'package-lock.json': lock({ 'some-lib': '^1.0.0' }, { 'some-lib': '1.0.0' }),
      },
    ],
    [
      second,
      {
        'package.json': manifest({ 'some-lib': '^1.2.0', 'widget-kit': '^2.0.0' }),
        'package-lock.json': lock(
          { 'some-lib': '^1.2.0', 'widget-kit': '^2.0.0' },
          { 'some-lib': '1.2.0', 'widget-kit': '2.0.1', 'tiny-dep': '0.3.0' },
        ),
      },
    ],
  ])
  compared = []
  reads = []
  fake.forge.readFile = async (_repo, file, ref) => {
    reads.push(`${ref}:${file}`)
    return ref ? filesAt.get(ref)?.[file] : undefined
  }
  fake.forge.compareCommits = async (_repo, from, to) => {
    compared.push([from, to])
    return from === first && to === second ? changedFiles : []
  }
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

const getJson = async <T>(path: string, headers = asAdmin) =>
  (await (await call('GET', path, undefined, headers)).json()) as T

const summarize = async (body: unknown) => {
  const response = await call('POST', '/releases/compare/summary', body)
  expect(response.status).toBe(200)
  return (await response.json()) as ReleaseCompareSummary
}

const fakeAgent = () => {
  const tasks: { tier?: string; taskKind?: string; prompt: string }[] = []
  deps.agentFor = async () => ({
    name: 'fake',
    run: async (task) => {
      tasks.push({ tier: task.tier, taskKind: task.taskKind, prompt: task.prompt })
      return {
        text: '',
        turns: 1,
        output: {
          overview: 'Dials arrive.',
          highlights: ['A dial on every widget'],
          codeChanges: ['A dial module'],
          dependencies: ['widget-kit is new'],
          check: ['Turn the dial'],
        },
      } as never
    },
  })
  app = createApp(deps)
  return tasks
}

describe('release comparison routes', () => {
  test('lists version tags newest first and the flow branches', async () => {
    fake.tag('v1.2.0-rc.1')
    const refs = await getJson<ReleaseCompareRefs>(`/releases/refs?repo=${repo}`)
    expect(refs.versions.map((version) => [version.tag, version.prerelease ?? false])).toEqual([
      ['v1.2.0-rc.1', true],
      ['v1.1.0', false],
      ['v1.0.0', false],
    ])
    expect(refs.versions[1]?.sha).toBe(second)
    expect(refs.branches).toEqual([
      { name: 'main', role: 'target' },
      { name: 'development', role: 'source' },
    ])
    expect((await call('GET', `/releases/refs?repo=${repo}`, undefined, asNobody)).status).toBe(403)
    expect((await call('GET', '/releases/refs')).status).toBe(400)
  })

  test('compares two versions with tasks, changelog and dependency changes, cached between tags', async () => {
    const view = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(view).toMatchObject({
      from: 'v1.0.0',
      to: 'v1.1.0',
      unreleased: false,
      commitCount: 2,
      bump: 'minor',
      summaryAvailable: false,
    })
    expect(view.tasks.map((task) => task.key).toSorted()).toEqual(['ABC-7', 'ABC-8'])
    expect(view.changelog).toContain('add dials')
    expect(view.dependenciesUnavailable).toBeUndefined()
    const root = view.dependencies?.roots[0]
    expect(root).toMatchObject({ path: '', ecosystem: 'npm', lockfile: 'package-lock.json' })
    expect(root?.direct.map((change) => [change.name, change.change])).toEqual([
      ['some-lib', 'updated'],
      ['widget-kit', 'added'],
    ])
    expect(root?.transitive).toEqual([{ name: 'tiny-dep', change: 'added', to: ['0.3.0'] }])
    expect(compared).toEqual([[first, second]])

    const readCount = reads.length
    await getJson<ReleaseCompareView>(`/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`)
    expect(compared).toHaveLength(1)
    expect(reads).toHaveLength(readCount)

    const next = await getJson<ReleaseCompareView>(`/releases/compare?repo=${repo}`)
    expect(next).toMatchObject({ from: 'v1.1.0', to: 'main', unreleased: true })
    expect(next.tasks.map((task) => task.key)).toEqual(['ABC-9'])
    expect(compared.at(-1)).toEqual([second, 'main'])
    expect(next.dependencies?.roots).toEqual([])

    const named = await getJson<ReleaseCompareView>(`/releases/compare?repo=${repo}&to=main`)
    expect(named).toMatchObject({ from: 'v1.1.0', to: 'main', unreleased: true })
  })

  test('does not keep dependency changes read with a failed file read', async () => {
    const readFile = fake.forge.readFile.bind(fake.forge)
    fake.forge.readFile = async (path, file, ref) => {
      if (file === 'package-lock.json' && ref === second) throw new Error('429 Too Many Requests')
      return readFile(path, file, ref)
    }
    const failed = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(failed.dependencies?.roots[0]?.errors.join('\n')).toContain('429')
    fake.forge.readFile = readFile
    const retried = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(compared).toHaveLength(2)
    expect(retried.dependencies?.roots[0]?.errors).toEqual([])
  })

  test('says why dependencies are missing', async () => {
    fake.forge.compareCommits = async () => {
      throw new Error('500 Internal Server Error')
    }
    const failed = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(failed.dependencies).toBeNull()
    expect(failed.dependenciesUnavailable).toBe(
      'comparing the commits failed: 500 Internal Server Error',
    )
    delete fake.forge.compareCommits
    const view = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(view.dependencies).toBeNull()
    expect(view.dependenciesUnavailable).toBe('the forge cannot compare commits')
    expect(view.commitCount).toBe(2)
  })

  test('a viewer reads the comparison but may not have it described', async () => {
    fakeAgent()
    const admin = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(admin.summaryAvailable).toBe(true)
    const viewer = await getJson<ReleaseCompareView>(
      `/releases/compare?repo=${repo}&from=v1.0.0&to=v1.1.0`,
      asViewer,
    )
    expect(viewer.summaryAvailable).toBe(false)
    const refused = await call(
      'POST',
      '/releases/compare/summary',
      { repo, from: 'v1.0.0', to: 'v1.1.0' },
      asViewer,
    )
    expect(refused.status).toBe(403)
  })

  test('describes a comparison with the AI agent, with code on a heavier tier, cached per flag', async () => {
    const tasks = fakeAgent()
    const plain = await summarize({ repo, from: 'v1.0.0', to: 'v1.1.0' })
    expect(plain).toMatchObject({ code: false, cached: false })
    expect(plain.markdown).toContain('Dials arrive.')
    expect(plain.markdown).toContain('widget-kit is new')
    expect(plain.markdown).not.toContain('A dial module')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ tier: 'fast', taskKind: 'release-notes' })
    expect(tasks[0]?.prompt).toContain('widget-kit')
    expect(tasks[0]?.prompt).not.toContain('export const dial')

    expect(await summarize({ repo, from: 'v1.0.0', to: 'v1.1.0' })).toMatchObject({
      cached: true,
      markdown: plain.markdown,
    })
    expect(tasks).toHaveLength(1)

    const withCode = await summarize({ repo, from: 'v1.0.0', to: 'v1.1.0', code: true })
    expect(withCode).toMatchObject({ code: true, cached: false })
    expect(withCode.markdown).toContain('A dial module')
    expect(tasks[1]?.tier).toBe('main')
    expect(tasks[1]?.prompt).toContain('export const dial')
    expect(tasks[1]?.prompt).not.toContain('"lockfileVersion"')

    const unreleased = await summarize({ repo })
    expect(unreleased.cached).toBe(false)
    expect(await summarize({ repo })).toMatchObject({ cached: false })
    expect(tasks).toHaveLength(4)
  })

  test('describes without code when the forge cannot compare commits', async () => {
    const tasks = fakeAgent()
    delete fake.forge.compareCommits
    const summary = await summarize({ repo, from: 'v1.0.0', to: 'v1.1.0', code: true })
    expect(summary).toMatchObject({ code: false, cached: false })
    expect(tasks[0]?.tier).toBe('fast')
  })

  test('answers 409 without an AI agent', async () => {
    const response = await call('POST', '/releases/compare/summary', { repo })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'no AI agent is configured for this repository',
    })
  })
})
