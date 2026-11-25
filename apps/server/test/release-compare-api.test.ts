import { beforeEach, describe, expect, test } from 'bun:test'

import type { ReleaseCompareApi, ReleaseComparePackage } from '@holtkeeper/api'
import type { ApiPackage, ApiSurfaceData } from '@holtkeeper/api-surface'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { releaseSettingsDefinition } from '@holtkeeper/release'
import { FakeForge } from '@holtkeeper/release/testing'
import { builtinSettings } from '@holtkeeper/settings'
import type { AnalysisHead, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import type { UsagesData } from '@holtkeeper/usages'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'
import { diffSnapshots, recordsAt } from '../src/release-api.ts'

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    viewer: [{ scope: { all: true }, actions: ['releases:read', 'catalog:read'] }],
    releasesOnly: [{ scope: { all: true }, actions: ['releases:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asViewer = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'viewer' }
const asNobody = { 'x-forwarded-user': 'eve', 'x-forwarded-groups': '' }

const repo = 'work:g/app'

const dial = (version: string, names: string[], name = '@widgets/dial'): ApiPackage => ({
  name,
  version,
  private: false,
  dir: `packages/${name.split('/')[1]}`,
  entries: [
    {
      subpath: '.',
      file: 'src/index.ts',
      symbols: names.map((symbol) => ({
        name: symbol,
        kind: 'function',
        signature: `function ${symbol}(): void`,
        file: 'src/index.ts',
        line: 1,
      })),
    },
  ],
})

const usage = (version: string): UsagesData => ({
  packages: [
    {
      name: '@widgets/dial',
      versions: [version],
      ranges: [`^${version}`],
      workspaces: ['root'],
      count: 1,
      files: 1,
      exports: [
        {
          name: 'stop',
          subpath: '.',
          count: 1,
          files: 1,
          kinds: { call: 1 },
          members: [],
          props: [],
          spread: 0,
          sites: [
            {
              file: 'src/panel.ts',
              line: 3,
              column: 1,
              kind: 'call',
              snippet: 'stop()',
              snippetLine: 3,
            },
          ],
        },
      ],
    },
  ],
  files: 4,
  types: { status: 'used', projects: ['tsconfig.json'], sites: 0 },
})

let fake: FakeForge
let store: Store
let app: ReturnType<typeof createApp>

const record = (data: ApiSurfaceData, createdAt: string, ref?: string, sha?: string) =>
  store.analyses.add({
    repo: { forge: 'work', path: 'g/app' },
    kind: 'api-surface',
    createdAt,
    data,
    ...(ref ? { ref } : {}),
    ...(sha ? { sha } : {}),
  })

beforeEach(async () => {
  fake = new FakeForge()
  fake.commitTo('main', 'feat: [ABC-1] first widget')
  fake.tag('v1.0.0')
  fake.commitTo('main', 'feat: [ABC-7] turn dials')
  fake.tag('v1.1.0')
  fake.commitTo('main', 'feat: [ABC-9] reset dials')
  fake.forge.readFile = async () => undefined
  fake.forge.compareCommits = async () => []
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: parseConfig({
      forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => fake.forge } },
    }),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, releaseSettingsDefinition],
    analyses: [],
    analyzers: [{ kind: 'api-surface', scope: 'repo', options: z.object({}) }],
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    releasePollMs: 1,
    releaseRefreshDelayMs: 0,
    onBackground: () => {},
  })
  await store.settings.put({
    id: 'releases',
    key: 'releases',
    scope: { all: true },
    value: { enabled: true, acceptance: 'manual' },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  const knob = dial('2.0.0', ['grip'], '@widgets/knob')
  await record(
    { packages: [dial('1.0.0', ['spin', 'stop']), knob] },
    '2026-10-01T00:00:00.000Z',
    'v1.0.0',
  )
  await record(
    { packages: [dial('1.1.0', ['spin', 'turn']), knob] },
    '2026-10-10T00:00:00.000Z',
    'v1.1.0',
  )
  await record(
    { packages: [dial('1.1.0', ['spin', 'turn', 'reset']), knob] },
    '2026-10-20T00:00:00.000Z',
  )
  await store.analyses.add({
    repo: { forge: 'work', path: 'g/panel' },
    kind: 'usages',
    createdAt: '2026-10-21T00:00:00.000Z',
    data: usage('1.0.0'),
  })
})

const get = (path: string, headers = asAdmin) => app.request(`/api${path}`, { headers })

const getJson = async <T>(path: string, headers = asAdmin) => {
  const response = await get(path, headers)
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

describe('release comparison of the public API', () => {
  test('lists the own packages that changed between two versions, with the uses they break', async () => {
    const api = await getJson<ReleaseCompareApi>(
      `/releases/compare/api?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(api).toMatchObject({ recorded: true, missing: [] })
    expect(api.backfill).toBeUndefined()
    expect(api.packages).toHaveLength(1)
    const [changed] = api.packages
    expect(changed).toMatchObject({ name: '@widgets/dial', from: '1.0.0', to: '1.1.0' })
    expect(changed?.diff).toMatchObject({
      removed: 1,
      added: 1,
      required: 'major',
      bumped: 'minor',
    })
    expect(changed?.markdown).toContain('# @widgets/dial: 1.0.0 → 1.1.0')
    expect(changed?.impact).toMatchObject({ repos: 1, breaking: 1, check: 0 })
    expect(changed?.impact?.markdown).toContain('work:g/panel')
  })

  test('reads the newest default-branch record for the target branch', async () => {
    const api = await getJson<ReleaseCompareApi>(`/releases/compare/api?repo=${repo}&from=v1.1.0`)
    expect(api.packages.map((pkg) => [pkg.name, pkg.diff?.added, pkg.diff?.removed])).toEqual([
      ['@widgets/dial', 1, 0],
    ])
    expect(api.packages[0]?.impact).toBeUndefined()
  })

  test('names packages without a record at one end and who may backfill them', async () => {
    fake.tag('v0.9.0', fake.branches.get('main'))
    const api = await getJson<ReleaseCompareApi>(
      `/releases/compare/api?repo=${repo}&from=v0.9.0&to=v1.1.0`,
    )
    expect(api.packages).toEqual([])
    expect(api.missing).toEqual([
      { name: '@widgets/dial', side: 'from' },
      { name: '@widgets/knob', side: 'from' },
    ])
    expect(api.backfill).toEqual({ allowed: true, refs: ['v0.9.0'] })
    const viewer = await getJson<ReleaseCompareApi>(
      `/releases/compare/api?repo=${repo}&from=v0.9.0&to=v1.1.0`,
      asViewer,
    )
    expect(viewer.backfill).toEqual({ allowed: false, refs: ['v0.9.0'] })
  })

  test('says when the repository has no records and checks access', async () => {
    await store.analyses.removeRepo({ forge: 'work', path: 'g/app' })
    const api = await getJson<ReleaseCompareApi>(
      `/releases/compare/api?repo=${repo}&from=v1.0.0&to=v1.1.0`,
    )
    expect(api).toEqual({
      packages: [],
      missing: [],
      recorded: false,
      backfill: { allowed: true, refs: ['v1.0.0', 'v1.1.0'] },
    })
    expect((await get(`/releases/compare/api?repo=${repo}`, asNobody)).status).toBe(403)
    expect((await get('/releases/compare/api')).status).toBe(400)
  })

  test('refuses a caller outside the catalog reach of the repository', async () => {
    await store.settings.put({
      id: 'cross-team',
      key: 'access.crossTeam',
      scope: { all: true },
      value: 'off',
      secret: false,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    const response = await get(`/releases/compare/api?repo=${repo}&from=v1.0.0&to=v1.1.0`, {
      'x-forwarded-user': 'ann',
      'x-forwarded-groups': 'releasesOnly',
    })
    expect(response.status).toBe(403)
  })
})

describe('release comparison of one dependency', () => {
  test('answers what package_changes says, narrowed to the repository', async () => {
    const found = await getJson<ReleaseComparePackage>(
      `/releases/compare/package?repo=work:g/panel&package=@widgets/dial&from=1.0.0&to=1.1.0`,
    )
    expect(found.found).toBe(true)
    expect(found.markdown).toContain('@widgets/dial 1.0.0 → 1.1.0 (organization package')
    expect(found.markdown).toContain('## Uses the upgrade affects')
    expect(found.markdown).toContain('work:g/panel')
  })

  test('says when the package is not indexed and checks the input', async () => {
    const missing = await getJson<ReleaseComparePackage>(
      `/releases/compare/package?repo=${repo}&package=some-lib&ecosystem=npm&from=1.0.0&to=2.0.0`,
    )
    expect(missing.found).toBe(false)
    expect(missing.markdown).not.toBe('')
    expect((await get(`/releases/compare/package?repo=${repo}`)).status).toBe(400)
    expect(
      (await get(`/releases/compare/package?repo=${repo}&package=x&ecosystem=pip`)).status,
    ).toBe(400)
    expect((await get(`/releases/compare/package?repo=${repo}&package=x`, asNobody)).status).toBe(
      403,
    )
  })
})

const head = (id: string, ref?: string, sha?: string): AnalysisHead => ({
  id,
  repo: { forge: 'work', path: 'g/app' },
  kind: 'api-surface',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...(ref ? { ref } : {}),
  ...(sha ? { sha } : {}),
})

describe('public API helpers', () => {
  test('recordsAt prefers the tag, then the commit, then default-branch runs at it', () => {
    const sha = 'a'.repeat(40)
    const heads = [head('1'), head('2', undefined, sha), head('3', sha), head('4', 'v2.0.0')]
    expect(recordsAt(heads, { ref: 'v2.0.0', sha }).map((item) => item.id)).toEqual(['4', '3', '2'])
    expect(recordsAt(heads, { ref: 'main', head: true }).map((item) => item.id)).toEqual(['1', '2'])
    expect(recordsAt(heads, { ref: 'v9.0.0' })).toEqual([])
  })

  test('diffSnapshots keeps changed, new and removed packages, breaking ones first', () => {
    const same = dial('1.0.0', ['grip'], '@widgets/knob')
    const result = diffSnapshots(
      [dial('1.0.0', ['spin']), same, dial('1.0.0', ['old'], '@widgets/gone')],
      [dial('1.1.0', ['spin', 'turn']), same, dial('0.1.0', ['fresh'], '@widgets/new')],
    )
    expect(result.map((item) => [item.name, item.diff.required])).toEqual([
      ['@widgets/gone', 'major'],
      ['@widgets/dial', 'minor'],
      ['@widgets/new', 'minor'],
    ])
  })
})
