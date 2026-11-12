import { beforeEach, describe, expect, test } from 'bun:test'

import { auditAnalysis } from '@holtkeeper/analyzers'
import type { RepoList } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { coverageAnalysis } from '@holtkeeper/coverage'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

const config = parseConfig({
  forges: { work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never } },
  groups: {
    shapes: { forge: 'work', include: ['shapes/*'] },
    colors: { forge: 'work', include: ['colors/*', 'colors/red'] },
  },
})

const auth = headerAuth({
  roles: {
    admin: [
      {
        scope: { all: true },
        actions: [
          'repos:read',
          'audits:read',
          'analyses:read',
          'releases:read',
          'settings:read',
          'settings:write',
        ],
      },
    ],
    viewer: [{ scope: { groups: ['shapes'] }, actions: ['repos:read'] }],
    auditor: [{ scope: { groups: ['shapes'] }, actions: ['audits:read'] }],
    analyst: [{ scope: { groups: ['shapes'] }, actions: ['analyses:read'] }],
    circle: [
      { scope: { groups: ['shapes'] }, actions: ['repos:read'] },
      { scope: { repos: ['work:shapes/circle'] }, actions: ['settings:read', 'analyses:read'] },
    ],
  },
})

const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

let store: Store

const app = () => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [auditAnalysis, coverageAnalysis],
    now: () => NOW,
  })
}

const list = async (role: string) => {
  const response = await app().request('/api/repos', { headers: as(role) })
  expect(response.status).toBe(200)
  return ((await response.json()) as RepoList).repos
}

const coverage = (path: string, percent: number) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'coverage',
    createdAt: hoursAgo(2),
    data: {},
    metrics: { percent, target: 60, files: 1, untested: 0 },
  })

const audit = (path: string, high: number) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'audit',
    createdAt: hoursAgo(3),
    data: {},
    metrics: {
      findings: high,
      severities: { critical: 0, high, medium: 0, low: 0, unknown: 0 },
      ignored: 0,
      expired: 0,
      resolved: 0,
    },
  })

beforeEach(async () => {
  store = memoryStore()
  await store.kv?.set('poll-group:shapes', {
    repos: [
      { forge: 'work', path: 'shapes/circle' },
      { forge: 'work', path: 'shapes/square' },
    ],
    listedAt: hoursAgo(1),
    attempts: [],
  })
})

describe('GET /api/repos', () => {
  test('lists every group member from stored listings and exact paths, not only audited ones', async () => {
    await coverage('shapes/circle', 81)
    const repos = await list('admin')
    expect(repos.map((r) => [`${r.repo.forge}:${r.repo.path}`, r.groups, r.health])).toEqual([
      ['work:colors/red', ['colors'], 'not-analysed'],
      ['work:shapes/circle', ['shapes'], 'healthy'],
      ['work:shapes/square', ['shapes'], 'not-analysed'],
    ])
    const circle = repos[1]
    expect(circle?.configurable).toBe(true)
    expect(circle?.cells.coverage).toEqual({ value: '81%', sub: 'target 60%', tone: 'ok' })
    expect(Object.keys(circle?.cells ?? {})).toEqual([
      'security',
      'dependencies',
      'coverage',
      'bundles',
      'jobs',
      'ci',
      'licenses',
      'release',
    ])
    expect(circle?.freshness).toEqual({ current: 1, total: 1 })
    expect(circle?.lastAnalysedAt).toBe(hoursAgo(2))
    expect(circle?.updates).toEqual({ via: 'off' })
  })

  test('omits cells, freshness and updates the caller may not read', async () => {
    await coverage('shapes/circle', 40)
    await audit('shapes/circle', 2)

    const viewer = await list('viewer')
    expect(viewer.map((r) => r.repo.path)).toEqual(['shapes/circle', 'shapes/square'])
    expect(viewer[0]).toEqual({
      repo: { forge: 'work', path: 'shapes/circle' },
      groups: ['shapes'],
      health: 'not-analysed',
      cells: {},
    })

    const auditor = await list('auditor')
    expect(Object.keys(auditor[0]?.cells ?? {})).toEqual(['security'])
    expect(auditor[0]?.cells.security).toEqual({ value: '2 high', sub: '', tone: 'bad' })
    expect(auditor[0]?.freshness).toBeUndefined()

    const analyst = await list('analyst')
    expect(analyst[0]?.cells.security).toBeUndefined()
    expect(analyst[0]?.cells.release).toBeUndefined()
    expect(analyst[0]?.cells.coverage).toEqual({ value: '40%', sub: 'below 60%', tone: 'bad' })
    expect(analyst[0]?.health).toBe('failing')
    expect(analyst[0]?.updates).toBeUndefined()
  })

  test('a narrow grant sees its own repository fully and updates only where it may read settings', async () => {
    await coverage('shapes/circle', 90)
    await coverage('shapes/square', 90)
    await store.kv?.set('webhook-seen:work:shapes/circle', hoursAgo(2))
    const repos = await list('circle')
    expect(repos.map((r) => [r.repo.path, r.updates?.via, r.cells.coverage?.value])).toEqual([
      ['shapes/circle', 'webhook', '90%'],
      ['shapes/square', undefined, undefined],
    ])
    expect(repos.some((r) => r.repo.path === 'colors/red')).toBe(false)
    expect(repos.every((r) => r.configurable === undefined)).toBe(true)
  })

  test('names the newest audit run to callers who may read audits', async () => {
    await store.auditRuns.add({
      repo: { forge: 'work', path: 'shapes/circle' },
      trigger: 'cli',
      startedAt: hoursAgo(5),
      finishedAt: hoursAgo(5),
      report: {
        scanner: 'osv-scanner',
        findings: [],
        ignored: [],
        expired: [],
        fixes: [],
        resolved: [],
        changedFiles: [],
      },
    })
    expect((await list('auditor'))[0]?.latestAudit?.finishedAt).toBe(hoursAgo(5))
    expect((await list('analyst'))[0]?.latestAudit).toBeUndefined()
  })

  test('callers without any grant on a repository do not see it', async () => {
    expect(await list('nobody')).toEqual([])
  })
})
