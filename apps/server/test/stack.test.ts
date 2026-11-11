import { beforeEach, expect, test } from 'bun:test'

import type { StackOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import { compareWithConvention, conventionChange, type StackData } from '@holtkeeper/stack'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    colors: { forge: 'work', include: ['colors/*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    shapes: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }

const at = '2026-11-10T00:00:00.000Z'
const weekAgo = '2026-11-03T00:00:00.000Z'

const nvmrc = { path: '.nvmrc', mode: 'exact' as const, content: '24\n', create: true }
const drift = (repo: string, actual: string | undefined) => {
  const comparison = compareWithConvention(nvmrc, actual)
  const change = conventionChange({ forge: 'work', path: repo }, nvmrc, comparison)
  return {
    repo,
    file: '.nvmrc',
    mode: 'exact' as const,
    status: comparison.status,
    problems: comparison.problems,
    ...(change ? { change } : {}),
  }
}

const node = (versions: Record<string, string>) => ({
  id: 'node',
  name: 'Node.js',
  kind: 'runtime' as const,
  latest: '26.1.0',
  latestLts: '24.11.0',
  cycles: [
    { cycle: '26', eol: '2029-04-30' },
    { cycle: '24', eol: '2028-04-30', lts: '2025-10-28' },
    { cycle: '18', eol: '2025-04-30', lts: true },
  ],
  usages: Object.entries(versions).map(([repo, version]) => ({
    repo,
    file: '.nvmrc',
    via: 'version-file' as const,
    declared: version,
    version,
  })),
})

const shapes = (
  versions: Record<string, string>,
  conventions: StackData['conventions'],
): StackData => ({
  group: 'shapes',
  checkedAt: at,
  soonDays: 180,
  repos: [
    { path: 'shapes/circle', files: ['.nvmrc'] },
    { path: 'shapes/square', files: [] },
  ],
  components: [node(versions)],
  conventions,
  notes: [],
})

let store: Store
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => new Date(at),
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'shapes' },
    kind: 'stack',
    createdAt: weekAgo,
    data: shapes({ 'shapes/circle': '24' }, [drift('shapes/circle', '24\n')]),
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'shapes' },
    kind: 'stack',
    createdAt: at,
    data: shapes({ 'shapes/circle': '18', 'shapes/square': '24.3' }, [
      drift('shapes/circle', '18\n'),
      drift('shapes/square', undefined),
    ]),
  })
  await store.analyses.add({
    repo: { forge: 'work', path: 'colors' },
    kind: 'stack',
    createdAt: at,
    data: {
      ...shapes({ 'colors/red': '26' }, [drift('colors/red', '20\n')]),
      group: 'colors',
      repos: [{ path: 'colors/red', files: ['.nvmrc'] }],
    },
  })
})

const get = async (headers: Record<string, string>) => {
  const response = await app.request('/api/stack', { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as StackOverview
}

test('one entry per group with uses judged at the record time and conventions with diffs', async () => {
  const { groups } = await get(asAdmin)
  expect(groups.map((group) => group.group)).toEqual(['colors', 'shapes'])
  const group = groups[1]
  expect(group?.repos).toEqual([
    { path: 'shapes/circle', groups: ['shapes'] },
    { path: 'shapes/square', groups: ['shapes'] },
  ])
  expect(
    group?.tools[0]?.uses.map((use) => [use.repo, use.version, use.support, use.lag, use.cycle]),
  ).toEqual([
    ['shapes/circle', '18', 'eol', 'major', '18'],
    ['shapes/square', '24.3', 'lts', 'major', '24'],
  ])
  expect(group?.tools[0]).toMatchObject({ latest: '26.1.0', latestLts: '24.11.0' })
  const [circle, square] = group?.conventions ?? []
  expect(circle).toMatchObject({ status: 'drifts', changeId: expect.stringMatching(/^stack:/) })
  expect(circle?.diff?.[0]).toMatchObject({ file: '.nvmrc', status: 'modified' })
  expect(square).toMatchObject({ status: 'missing', problems: ['file is missing'] })
  expect(group?.changes).toEqual({
    since: weekAgo,
    newEol: 1,
    resolvedEol: 0,
    newDrifts: 2,
    resolvedDrifts: 0,
  })
})

const crossTeam = (level: 'off' | 'metadata' | 'snippets') =>
  store.settings.put({
    id: 'cross-team',
    key: 'access.crossTeam',
    scope: { all: true },
    value: level,
    secret: false,
    updatedAt: at,
  })

test('other teams show through the cross-team catalog, without convention fixes', async () => {
  const { groups } = await get(asShapes)
  expect(groups.map((group) => group.group)).toEqual(['colors', 'shapes'])
  expect(groups[0]?.repos).toEqual([{ path: 'colors/red', groups: ['colors'] }])
  expect(groups[0]?.conventions).toEqual([
    {
      repo: 'colors/red',
      file: '.nvmrc',
      mode: 'exact',
      status: 'drifts',
      problems: expect.any(Array),
    },
  ])
  const own = groups[1]?.conventions.find((result) => result.repo === 'shapes/circle')
  expect(own?.changeId).toMatch(/^stack:/)
})

test('with the cross-team catalog off, only groups and repositories the caller may read', async () => {
  await crossTeam('off')
  const { groups } = await get(asShapes)
  expect(groups.map((group) => group.group)).toEqual(['shapes'])
})
