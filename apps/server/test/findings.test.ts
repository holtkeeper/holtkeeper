import { beforeEach, expect, test } from 'bun:test'

import { recordMetrics } from '@holtkeeper/analyzer'
import type { FindingsResponse } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { AgentTask, AnalysisStore, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import type { AuditReport, Finding } from '@holtkeeper/vuln'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApp } from '../src/app.ts'
import { readFindings } from '../src/findings.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    web: { forge: 'work', include: ['acme/web-*'] },
    pay: { forge: 'work', include: ['acme/pay-*'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    webAuditor: [{ scope: { groups: ['web'] }, actions: ['audits:read'] }],
    reader: [{ scope: { all: true }, actions: ['analyses:read', 'repos:read'] }],
  },
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const kinds = new Map(builtinAnalyses.map((kind) => [kind.kind, kind]))
const audit = kinds.get('audit')

const finding = (id: string, pkg: string, version: string, extra: Partial<Finding> = {}) => ({
  id,
  aliases: [`CVE-2026-${id.slice(-1)}000`],
  summary: `Widget overflow in ${pkg}`,
  severity: 'high' as const,
  url: `https://osv.test/${id}`,
  package: { name: pkg, version, ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['9.9.9'],
  ...extra,
})

const report = (findings: Finding[], ignored: AuditReport['ignored'] = []): AuditReport => ({
  scanner: 'osv-scanner',
  findings,
  ignored,
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
})

let store: Store
let app: ReturnType<typeof createApp>

const ingest = async (path: string, createdAt: string, data: AuditReport) => {
  const repo = { forge: 'work', path }
  const metrics = await recordMetrics(store.analyses, audit, { repo, createdAt, data })
  await store.analyses.add({
    repo,
    kind: 'audit',
    createdAt,
    data,
    ...(metrics ? { metrics } : {}),
  })
}

const task = (id: string, repo: string, status: AgentTask['status']): AgentTask => ({
  id,
  groupId: `g-${id}`,
  kind: 'upgrade',
  title: 'Upgrade some-lib',
  prompt: 'Upgrade some-lib to 9.9.9',
  repo,
  requester: 'admin',
  source: { type: 'dependency-upgrade', ecosystem: 'npm', package: 'some-lib', to: '9.9.9' },
  status,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
})

const findings = async (role: string, query = '') => {
  const response = await app.request(`/api/audits/findings${query}`, { headers: as(role) })
  expect(response.status).toBe(200)
  return (await response.json()) as FindingsResponse
}

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
    now: () => new Date('2026-11-10T12:00:00.000Z'),
  })
  await ingest(
    'acme/web-shop',
    '2026-11-01T00:00:00.000Z',
    report([finding('GHSA-1', 'some-lib', '1.0.0')]),
  )
  await ingest(
    'acme/web-shop',
    '2026-11-05T00:00:00.000Z',
    report([
      finding('GHSA-1', 'some-lib', '1.0.1'),
      finding('GHSA-2', 'other-lib', '2.0.0', { severity: 'critical' }),
    ]),
  )
  await ingest(
    'acme/web-admin',
    '2026-11-06T00:00:00.000Z',
    report([finding('GHSA-1', 'some-lib', '1.0.0', { source: 'apps/a/package-lock.json' })]),
  )
  await ingest(
    'acme/pay-core',
    '2026-11-06T00:00:00.000Z',
    report([finding('GHSA-3', 'foo-util', '3.0.0', { severity: 'low' })]),
  )
})

test('groups findings by advisory and package across the newest audits', async () => {
  const body = await findings('admin')
  expect(body.groups.map((group) => `${group.advisory} ${group.package}`)).toEqual([
    'GHSA-2 other-lib',
    'GHSA-1 some-lib',
    'GHSA-3 foo-util',
  ])
  expect(body.severities).toEqual({ critical: 1, high: 1, medium: 0, low: 1, unknown: 0 })
  const some = body.groups[1]
  expect(some).toMatchObject({
    aliases: ['CVE-2026-1000'],
    summary: 'Widget overflow in some-lib',
    ecosystem: 'npm',
    severity: 'high',
    fixedIn: ['9.9.9'],
    status: 'open',
  })
  expect(some?.repos).toEqual([
    {
      repo: 'work:acme/web-admin',
      groups: ['web'],
      versions: ['1.0.0'],
      sources: ['apps/a/package-lock.json'],
      status: 'open',
    },
    {
      repo: 'work:acme/web-shop',
      groups: ['web'],
      versions: ['1.0.1'],
      sources: ['package-lock.json'],
      status: 'open',
    },
  ])
})

test('repositories whose audit is turned off leave the findings', async () => {
  await store.settings.put({
    id: 'off-pay',
    key: 'repo.analyzers',
    scope: { repos: ['acme/pay-core'] },
    value: { off: ['audit'], reason: 'Values only' },
    secret: false,
    updatedAt: '2026-11-09T00:00:00.000Z',
  })
  const body = await findings('admin')
  expect(body.groups.map((group) => group.advisory)).toEqual(['GHSA-2', 'GHSA-1'])
  expect(body.severities.low).toBe(0)
})

test('first seen carries over between audits of a repository', async () => {
  const body = await findings('admin')
  const byAdvisory = new Map(body.groups.map((group) => [group.advisory, group.firstSeenAt]))
  expect(byAdvisory.get('GHSA-1')).toBe('2026-11-01T00:00:00.000Z')
  expect(byAdvisory.get('GHSA-2')).toBe('2026-11-05T00:00:00.000Z')
})

test('approved and running upgrade tasks mark findings as fixing, read past the cache', async () => {
  expect((await findings('admin')).groups[1]?.status).toBe('open')
  await store.tasks.put(task('t-1', 'work:acme/web-shop', 'running'))
  await store.tasks.put(task('t-2', 'work:acme/web-admin', 'proposed'))

  let some = (await findings('admin')).groups[1]
  expect(some?.status).toBe('open')
  expect(some?.repos.map((repo) => [repo.repo, repo.status, repo.taskId])).toEqual([
    ['work:acme/web-admin', 'open', undefined],
    ['work:acme/web-shop', 'fixing', 't-1'],
  ])

  await store.tasks.put(task('t-2', 'work:acme/web-admin', 'mr-open'))
  some = (await findings('admin')).groups[1]
  expect(some).toMatchObject({ status: 'fixing', taskId: 't-2' })
  expect((await findings('admin')).groups[0]?.status).toBe('open')
})

test('a fix task from the finding sheet marks the finding as fixing', async () => {
  await store.tasks.put({
    ...task('t-3', 'work:acme/web-shop', 'queued'),
    kind: 'fix',
    title: 'Fix GHSA-1 in some-lib',
    source: { type: 'dependency-upgrade', ecosystem: 'npm', package: 'some-lib', to: '1.0.2' },
  })
  const some = (await findings('admin')).groups[1]
  expect(some?.repos.find((repo) => repo.repo === 'work:acme/web-shop')).toMatchObject({
    status: 'fixing',
    taskId: 't-3',
  })
})

test('allowlisted findings stay allowlisted until their entry expires', async () => {
  await ingest(
    'acme/web-shop',
    '2026-11-07T00:00:00.000Z',
    report(
      [],
      [
        {
          finding: finding('GHSA-1', 'some-lib', '1.0.1'),
          entry: { id: 'GHSA-1', reason: 'not reachable', expires: '2026-12-01' },
        },
        {
          finding: finding('GHSA-2', 'other-lib', '2.0.0', { severity: 'critical' }),
          entry: { id: 'GHSA-2', reason: 'dev only', expires: '2026-11-08' },
        },
      ],
    ),
  )
  const body = await findings('admin', '?repo=work:acme/web-shop')
  expect(body.groups.map((group) => [group.advisory, group.status])).toEqual([
    ['GHSA-2', 'open'],
    ['GHSA-1', 'allowlisted'],
  ])
  expect(body.groups[1]?.firstSeenAt).toBe('2026-11-01T00:00:00.000Z')
})

test('a narrow grant sees only the repositories it may read audits of', async () => {
  const body = await findings('webAuditor')
  expect(body.groups.map((group) => group.advisory)).toEqual(['GHSA-2', 'GHSA-1'])
  expect(body.groups.flatMap((group) => group.repos.map((repo) => repo.repo))).not.toContain(
    'work:acme/pay-core',
  )
  expect(body.severities.low).toBe(0)
  expect((await findings('webAuditor', '?repo=work:acme/pay-core')).groups).toEqual([])
  expect((await findings('reader')).groups).toEqual([])
})

test('the table reads stored metrics only, never record data', async () => {
  const analyses: AnalysisStore = {
    ...store.analyses,
    get: () => Promise.reject(new Error('data read')),
    list: () => Promise.reject(new Error('data read')),
    latest: () => Promise.reject(new Error('data read')),
  }
  const principal = {
    id: 'admin',
    name: 'Admin',
    provider: 'test',
    grants: [{ scope: { all: true }, actions: ['*' as const] }],
  }
  const body = await readFindings(
    {
      config,
      store: { analyses, tasks: store.tasks, settings: store.settings },
      kinds,
      today: '2026-11-10',
    },
    principal,
  )
  expect(body.groups).toHaveLength(3)
})
