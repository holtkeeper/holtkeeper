import { beforeEach, expect, test } from 'bun:test'

import type { LicensesOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import {
  type LicensedPackage,
  type LicensesData,
  licensePresets,
  licensesMetrics,
} from '@holtkeeper/licenses'
import { builtinSettings } from '@holtkeeper/settings'
import type { AnalysisStore, Store } from '@holtkeeper/store'
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
    shapes: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read', 'settings:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asShapes = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'shapes' }

const at = '2026-11-10T00:00:00.000Z'
const eightDaysAgo = '2026-11-02T00:00:00.000Z'
const twoDaysAgo = '2026-11-08T00:00:00.000Z'

const pkg = (
  name: string,
  verdict: LicensedPackage['verdict'],
  licenses: string[],
  extra: Partial<LicensedPackage> = {},
): LicensedPackage => ({
  name,
  version: '1.0.0',
  ecosystem: 'npm',
  sources: ['package-lock.json'],
  licenses,
  verdict,
  ...(verdict === 'denied' || verdict === 'unlisted' ? { culprits: licenses } : {}),
  ...extra,
})

const scan = (packages: LicensedPackage[], extra: Partial<LicensesData> = {}): LicensesData => ({
  tool: { name: 'osv-scanner', version: '2.7.0' },
  policy: { allow: ['MIT'], deny: ['GPL-*'], ignore: [] },
  packages,
  ...extra,
})

const circleNow = scan(
  [
    pkg('widget-core', 'allowed', ['MIT']),
    pkg('gizmo', 'denied', ['GPL-3.0-only'], { groups: ['dev'] }),
    pkg('sprocket', 'unlisted', ['MPL-2.0']),
    pkg('shape-kit', 'internal', [], { definedIn: 'work:shapes/kit' }),
  ],
  {
    policy: { allow: ['MIT'], deny: ['GPL-*'], ignore: [], requireProjectLicense: true },
    project: { licenseFiles: [] },
  },
)
const circleBefore = scan([
  pkg('widget-core', 'allowed', ['MIT']),
  pkg('sprocket', 'unlisted', ['MPL-2.0']),
  pkg('cog', 'unknown', []),
])
const redNow = scan([
  pkg('widget-core', 'allowed', ['MIT'], { version: '1.2.0' }),
  pkg('gizmo', 'denied', ['GPL-3.0-only'], { version: '2.0.0' }),
  pkg('doohickey', 'unknown', []),
])

let store: Store
let app: ReturnType<typeof createApp>
let dataReads: string[]

const add = (path: string, createdAt: string, data: LicensesData, metrics: object | null = null) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'licenses',
    createdAt,
    data,
    ...(metrics === null ? { metrics: licensesMetrics(data) } : { metrics }),
  })

const counting = (analyses: AnalysisStore): AnalysisStore => ({
  ...analyses,
  get: async (id) => {
    dataReads.push(`get:${id}`)
    return analyses.get(id)
  },
  list: async (query) => {
    dataReads.push('list')
    return analyses.list(query)
  },
  latest: async (query) => {
    dataReads.push('latest')
    return analyses.latest(query)
  },
})

beforeEach(async () => {
  store = memoryStore()
  dataReads = []
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth,
    store: { ...store, analyses: counting(store.analyses) },
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => new Date(at),
  })
})

const get = async (headers: Record<string, string>) => {
  const response = await app.request('/api/licenses', { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as LicensesOverview
}

const commercial = licensePresets.find((preset) => preset.id === 'commercial')

test('totals, mix, violations, rows and the organization policy', async () => {
  await add('shapes/circle', at, circleNow)
  await add('colors/red', at, redNow)
  await store.settings.put({
    id: 'org-licenses',
    key: 'analyzers.licenses',
    scope: { all: true },
    value: commercial?.options,
    secret: false,
    updatedAt: twoDaysAgo,
    updatedBy: 'jane',
  })
  await store.settings.put({
    id: 'colors-licenses',
    key: 'analyzers.licenses',
    scope: { groups: ['colors'] },
    value: { unknown: 'violation' },
    secret: false,
    updatedAt: twoDaysAgo,
  })

  const overview = await get(asAdmin)
  expect(overview.kpi).toEqual({
    packages: 6,
    repos: 2,
    denied: 1,
    review: 1,
    unknown: 1,
    licenses: 4,
    allowedLicenses: 1,
    internal: 1,
    missingLicenseFile: 1,
  })
  expect(overview.mix).toEqual([
    { license: 'GPL-3.0-only', packages: 2 },
    { license: 'MIT', packages: 2 },
    { license: 'MPL-2.0', packages: 1 },
    { license: 'UNKNOWN', packages: 1 },
  ])
  expect(overview.violations).toEqual([
    {
      package: 'gizmo',
      ecosystem: 'npm',
      versions: ['1.0.0', '2.0.0'],
      licenses: ['GPL-3.0-only'],
      verdict: 'denied',
      culprits: ['GPL-3.0-only'],
      dev: false,
      repos: [
        { repo: 'work:colors/red', groups: ['colors'] },
        { repo: 'work:shapes/circle', groups: ['shapes'] },
      ],
    },
    {
      package: 'sprocket',
      ecosystem: 'npm',
      versions: ['1.0.0'],
      licenses: ['MPL-2.0'],
      verdict: 'unlisted',
      culprits: ['MPL-2.0'],
      dev: false,
      repos: [{ repo: 'work:shapes/circle', groups: ['shapes'] }],
    },
    {
      package: 'doohickey',
      ecosystem: 'npm',
      versions: ['1.0.0'],
      licenses: [],
      verdict: 'unknown',
      culprits: [],
      dev: false,
      repos: [{ repo: 'work:colors/red', groups: ['colors'] }],
    },
  ])
  expect(overview.repos.map((row) => [row.repo, row.packages, row.licenseFile])).toEqual([
    ['work:shapes/circle', 3, 'missing'],
    ['work:colors/red', 3, 'not-required'],
  ])
  expect(overview.repos[0]?.verdicts).toEqual({
    allowed: 1,
    unknown: 0,
    unlisted: 1,
    denied: 1,
    ignored: 0,
    internal: 1,
    excepted: 0,
  })
  expect(overview.policy).toMatchObject({
    preset: 'Commercial product',
    review: [],
    devDependencies: 'check',
    exceptions: [],
    unknown: 'warn',
    requireProjectLicense: false,
    overrides: 1,
    updatedAt: twoDaysAgo,
    updatedBy: 'jane',
  })
  expect(overview.deltas).toBeUndefined()
})

test('deltas compare flagged packages with the scan about a week older', async () => {
  await add('shapes/circle', eightDaysAgo, circleBefore)
  await add('shapes/circle', twoDaysAgo, circleBefore)
  await add('shapes/circle', at, circleNow)
  await add('colors/red', at, redNow)

  const { deltas } = await get(asAdmin)
  expect(deltas).toEqual({
    since: eightDaysAgo,
    denied: { added: 1, resolved: 0 },
    review: { added: 0, resolved: 0 },
    unknown: { added: 0, resolved: 1 },
  })
})

test('a narrow grant sees only its own repositories and not the organization policy', async () => {
  await add('shapes/circle', at, circleNow)
  await add('colors/red', at, redNow)
  await store.settings.put({
    id: 'org-licenses',
    key: 'analyzers.licenses',
    scope: { all: true },
    value: commercial?.options,
    secret: false,
    updatedAt: twoDaysAgo,
    updatedBy: 'jane',
  })

  const overview = await get(asShapes)
  expect(overview.repos.map((row) => row.repo)).toEqual(['work:shapes/circle'])
  expect(overview.kpi.repos).toBe(1)
  expect(overview.kpi.unknown).toBe(0)
  expect(overview.violations.map((violation) => violation.package)).toEqual(['gizmo', 'sprocket'])
  expect(overview.violations[0]).toMatchObject({
    versions: ['1.0.0'],
    dev: true,
    repos: [{ repo: 'work:shapes/circle', groups: ['shapes'] }],
  })
  expect(overview.policy).toBeUndefined()
  expect((await get(asAdmin)).policy?.updatedBy).toBe('jane')
})

test('rows, totals, violations and deltas come from metrics without reading data', async () => {
  const clean = scan([pkg('widget-core', 'allowed', ['MIT'])])
  await add('shapes/circle', eightDaysAgo, clean)
  await add('shapes/circle', at, clean)
  await add('colors/red', at, redNow)

  const overview = await get(asAdmin)
  expect(overview.repos).toHaveLength(2)
  expect(overview.violations.map((violation) => violation.package)).toEqual(['gizmo', 'doohickey'])
  expect(overview.deltas?.since).toBe(eightDaysAgo)
  expect(dataReads).toEqual([])
})

test('records stored before the newer metrics fields have them computed from data', async () => {
  const { flagged: _flagged, flaggedDetails: _details, ...older } = licensesMetrics(redNow)
  await add('colors/red', at, redNow, older)

  const overview = await get(asAdmin)
  expect(overview.kpi).toMatchObject({ denied: 1, unknown: 1, licenses: 3 })
  expect(overview.violations.map((violation) => violation.package)).toEqual(['gizmo', 'doohickey'])
  expect(overview.repos[0]?.licenseFile).toBe('not-required')
})

test('answers again from the cache while the newest records stay the same', async () => {
  const { flaggedDetails: _details, ...older } = licensesMetrics(redNow)
  await add('colors/red', at, redNow, older)
  await get(asAdmin)
  const reads = dataReads.length
  expect(reads).toBeGreaterThan(0)
  await get(asAdmin)
  expect(dataReads).toHaveLength(reads)

  await add('colors/red', '2026-11-11T00:00:00.000Z', redNow, older)
  await get(asAdmin)
  expect(dataReads.length).toBeGreaterThan(reads)
})
