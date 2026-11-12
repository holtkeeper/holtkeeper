import { beforeEach, expect, test } from 'bun:test'

import { recordMetrics } from '@holtkeeper/analyzer'
import type { DependencyTable, FindingsResponse, LicensesOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type DepEdge, type DepNode, analyzeLayer } from '@holtkeeper/depgraph'
import { type LicensedPackage, licensesMetrics } from '@holtkeeper/licenses'
import { builtinSettings } from '@holtkeeper/settings'
import type { AnalysisStore, AuditRunStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import type { Finding } from '@holtkeeper/vuln'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: { web: { forge: 'work', include: ['acme/*'] } },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const at = '2026-11-06T00:00:00.000Z'
const audit = builtinAnalyses.find((kind) => kind.kind === 'audit')

let store: Store
let app: ReturnType<typeof createApp>
let reads: string[]

const counting = (analyses: AnalysisStore): AnalysisStore => ({
  ...analyses,
  get: async (id) => {
    const record = await analyses.get(id)
    reads.push(`get:${record?.kind}`)
    return record
  },
  list: async (query) => {
    reads.push(`list:${query?.kind ?? '*'}`)
    return analyses.list(query)
  },
  latest: async (query) => {
    reads.push(`latest:${query?.kind ?? '*'}`)
    return analyses.latest(query)
  },
})

const countingRuns = (auditRuns: AuditRunStore): AuditRunStore => ({
  ...auditRuns,
  list: async (query) => {
    reads.push('list:audit-runs')
    return auditRuns.list(query)
  },
  get: async (id) => {
    reads.push('get:audit-run')
    return auditRuns.get(id)
  },
})

const add = async (path: string, kind: string, data: unknown, metrics?: object) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind,
    createdAt: at,
    data,
    ...(metrics && { metrics }),
  })

const finding = (id: string, pkg: string): Finding => ({
  id,
  aliases: [],
  summary: `Widget overflow in ${pkg}`,
  severity: 'high',
  url: `https://osv.test/${id}`,
  package: { name: pkg, version: '1.0.0', ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['1.0.1'],
})

const ingestAudit = async (path: string, findings: Finding[]) => {
  const data = {
    scanner: 'osv-scanner',
    findings,
    ignored: [],
    expired: [],
    fixes: [],
    resolved: [],
    changedFiles: [],
  }
  const repo = { forge: 'work', path }
  await add(
    path,
    'audit',
    data,
    await recordMetrics(store.analyses, audit, { repo, createdAt: at, data }),
  )
}

const licensed = (name: string, verdict: LicensedPackage['verdict']): LicensedPackage => ({
  name,
  version: '1.0.0',
  ecosystem: 'npm',
  sources: ['package-lock.json'],
  licenses: verdict === 'denied' ? ['GPL-3.0-only'] : ['MIT'],
  verdict,
  ...(verdict === 'denied' ? { culprits: ['GPL-3.0-only'] } : {}),
})

const ingestLicenses = (path: string, packages: LicensedPackage[]) => {
  const data = {
    tool: { name: 'osv-scanner', version: '2.7.0' },
    policy: { allow: ['MIT'], deny: ['GPL-*'], ignore: [] },
    packages,
  }
  return add(path, 'licenses', data, licensesMetrics(data))
}

const npm = (id: string, name: string, version?: string): DepNode => ({
  id,
  name,
  ...(version ? { version } : {}),
  ecosystem: 'npm',
  kind: version ? 'package' : 'workspace',
})

const ingestDepgraph = (path: string, nodes: DepNode[], edges: DepEdge[]) =>
  add(path, 'depgraph', {
    layers: [analyzeLayer({ id: 'packages', source: 'test', graph: { nodes, edges } })],
    errors: [],
  })

const get = async <T>(path: string) => {
  const response = await app.request(path, { headers: asAdmin })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

beforeEach(async () => {
  store = memoryStore()
  reads = []
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth: headerAuth({ roles: { admin: [{ scope: { all: true }, actions: ['*'] }] } }),
    store: {
      ...store,
      analyses: counting(store.analyses),
      auditRuns: countingRuns(store.auditRuns),
    },
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now: () => new Date('2026-11-10T00:00:00.000Z'),
  })

  await ingestAudit('acme/shop', [finding('GHSA-1', 'some-lib'), finding('GHSA-2', 'other-lib')])
  await ingestAudit('acme/admin', [finding('GHSA-1', 'some-lib')])
  await store.auditRuns.add({
    repo: { forge: 'work', path: 'acme/shop' },
    trigger: 'cli',
    startedAt: at,
    finishedAt: at,
    report: {
      scanner: 'osv-scanner',
      findings: [finding('GHSA-9', 'some-lib')],
      ignored: [],
      expired: [],
      fixes: [],
      resolved: [],
      changedFiles: [],
    },
  })
  await ingestLicenses('acme/shop', [licensed('some-lib', 'allowed')])
  await ingestLicenses('acme/admin', [licensed('some-lib', 'allowed'), licensed('gizmo', 'denied')])
  await ingestDepgraph(
    'acme/shop',
    [npm('shop', 'shop'), npm('s@1', 'some-lib', '1.0.0')],
    [{ from: 'shop', to: 's@1', kind: 'prod' }],
  )
  reads = []
})

test('the findings table reads no record data', async () => {
  const body = await get<FindingsResponse>('/api/audits/findings')
  expect(body.groups.map((group) => [group.advisory, group.repos.length])).toEqual([
    ['GHSA-1', 2],
    ['GHSA-2', 1],
  ])
  expect(reads).toEqual([])
})

test('the licenses table reads no record data, violation details included', async () => {
  const body = await get<LicensesOverview>('/api/licenses')
  expect(body.repos.map((row) => row.repo)).toEqual(['work:acme/admin', 'work:acme/shop'])
  expect(body.violations).toEqual([
    {
      package: 'gizmo',
      ecosystem: 'npm',
      versions: ['1.0.0'],
      licenses: ['GPL-3.0-only'],
      verdict: 'denied',
      culprits: ['GPL-3.0-only'],
      dev: false,
      repos: [{ repo: 'work:acme/admin', groups: ['web'] }],
    },
  ])
  expect(reads).toEqual([])

  await ingestLicenses('acme/admin', [licensed('some-lib', 'allowed')])
  reads = []
  const clean = await get<LicensesOverview>('/api/licenses')
  expect(clean.kpi).toMatchObject({ repos: 2, denied: 0 })
  expect(reads).toEqual([])
})

test('the dependencies table reads no data of license, audit, bundle or Renovate records', async () => {
  const body = await get<DependencyTable>('/api/dependencies')
  expect(body.libraries.find((row) => row.name === 'some-lib')?.advisories).toEqual({
    count: 1,
    severity: 'high',
  })
  expect(reads.filter((read) => !/:(depgraph|usages|api-surface)$/.test(read))).toEqual([])
})

test('fleet tables read nothing again while the newest records stay the same', async () => {
  await get('/api/audits/findings')
  await get('/api/licenses')
  await get('/api/dependencies')
  reads = []
  await get('/api/audits/findings')
  await get('/api/licenses')
  await get('/api/dependencies')
  expect(reads).toEqual([])
})
