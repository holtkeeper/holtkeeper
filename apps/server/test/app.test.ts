import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  AnalysisDetail,
  AnalysisList,
  AnalysisSummary,
  AuditRunDetail,
  AuditRunList,
  CredentialList,
  CredentialView,
  MeResponse,
  RepoList,
  ResolvedSettings,
  SettingList,
} from '@holtkeeper/api'
import type { AuthProvider } from '@holtkeeper/auth'
import { headerAuth } from '@holtkeeper/auth-header'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { defineAnalysis, metric } from '@holtkeeper/report'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import { z } from 'zod'

import { createApp } from '../src/app.ts'

const renameChange = {
  id: 'rename',
  title: 'Use SCREAMING_SNAKE_CASE',
  confidence: 'review' as const,
  source: 'conventions',
  edits: [
    {
      kind: 'replace' as const,
      file: 'src/a.ts',
      range: { start: { line: 1, column: 7 }, end: { line: 1, column: 10 } },
      oldText: 'max',
      newText: 'MAX',
    },
  ],
}

const forgeFiles: Record<string, string> = { 'src/a.ts': 'const max = 1\n' }
const openedRequests: unknown[] = []
const fakeForge = {
  kind: 'fake',
  getRepository: async () => ({
    path: 'games/a',
    name: 'a',
    defaultBranch: 'main',
    webUrl: '',
    cloneUrl: '',
    archived: false,
  }),
  readFile: async (_repo: string, file: string) => forgeFiles[file],
  commit: async () => ({ sha: 'abc', webUrl: '' }),
  createMergeRequest: async (_repo: string, input: { title: string }) => {
    openedRequests.push(input)
    return { id: 3, webUrl: 'https://forge.test/mr/3' }
  },
}

const sizeKind = defineAnalysis<{ bytes: number }>({
  kind: 'size',
  label: 'Size',
  changes: () => [renameChange],
  schema: z.object({ bytes: z.number() }),
  summarize: (data) => [metric('bytes', 'Bytes', data.bytes, { unit: 'bytes' })],
  toReport: (current, previous) => ({
    kind: 'size',
    title: `Size of ${current.ref ?? 'HEAD'}`,
    generatedAt: current.createdAt,
    metrics: [
      metric('bytes', 'Bytes', current.data.bytes, {
        unit: 'bytes',
        ...(previous ? { previous: previous.data.bytes } : {}),
        better: 'down',
      }),
    ],
    sections: [],
  }),
})

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => fakeForge } },
  groups: {
    games: { forge: 'work', include: ['games/*'] },
    tools: { forge: 'work', include: ['tools/*'] },
  },
})

const report = (severity: 'high' | 'low') => ({
  scanner: 'osv-scanner',
  findings: [
    {
      id: 'GHSA-1',
      aliases: ['CVE-1'],
      summary: 'bad',
      severity,
      url: 'https://osv.dev/GHSA-1',
      package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
      source: 'pnpm-lock.yaml',
      fixedVersions: ['4.17.21'],
    },
  ],
  ignored: [],
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
})

const run = (path: string, finishedAt: string) => ({
  repo: { forge: 'work', path },
  trigger: 'cli',
  startedAt: finishedAt,
  finishedAt,
  report: report('high'),
})

let store: Store
const setup = (auth: AuthProvider = noAuth()) => {
  const vault = aesVault('v'.repeat(32))
  return createApp({
    config,
    auth,
    store,
    vault,
    credentials: createCredentialService({
      credentials: store.credentials,
      activity: store.activity,
      vault,
    }),
    settings: builtinSettings,
    analyses: [sizeKind],
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  })
}

const games = headerAuth({
  roles: {
    games: [
      {
        scope: { groups: ['games'] },
        actions: ['audits:read', 'settings:read', 'settings:write', 'credentials:read'],
      },
    ],
  },
})
const asGames = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'games' }

const send = (
  app: ReturnType<typeof setup>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

beforeEach(() => {
  store = memoryStore()
})

describe('server', () => {
  test('/api/me reports the principal and auth info', async () => {
    const me = (await (await setup().request('/api/me')).json()) as MeResponse
    expect(me).toMatchObject({ principal: { id: 'root' }, auth: { provider: 'none', methods: [] } })

    const anonymous = (await (await setup(games).request('/api/me')).json()) as MeResponse
    expect(anonymous.principal).toBeNull()
    expect((await setup(games).request('/api/audit-runs')).status).toBe(401)
  })

  test('ingests audit runs and lists them with summaries', async () => {
    const app = setup()
    const created = await send(
      app,
      'POST',
      '/api/audit-runs',
      run('games/a', '2026-10-29T10:00:00.000Z'),
    )
    expect(created.status).toBe(201)
    const detail = (await created.json()) as AuditRunDetail
    expect(detail.summary).toMatchObject({
      active: 1,
      severities: { high: 1 },
      tools: ['pnpm'],
      languages: ['JavaScript'],
    })
    expect(detail.run.actor).toBe('root')

    await send(app, 'POST', '/api/audit-runs', run('games/a', '2026-10-30T10:00:00.000Z'))
    const list = (await (
      await app.request('/api/audit-runs?repo=work:games/a&limit=1')
    ).json()) as AuditRunList
    expect(list.runs.map((r) => r.finishedAt)).toEqual(['2026-10-30T10:00:00.000Z'])

    const one = await app.request(`/api/audit-runs/${detail.run.id}`)
    expect(((await one.json()) as AuditRunDetail).run.report.findings).toHaveLength(1)
    expect((await store.activity.list()).map((e) => e.action)).toEqual([
      'audit.ingested',
      'audit.ingested',
    ])
  })

  test('rejects malformed reports', async () => {
    const response = await send(setup(), 'POST', '/api/audit-runs', {
      ...run('games/a', 'yesterday'),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain('startedAt')
  })

  test('scopes audit runs and repositories to the caller', async () => {
    await store.auditRuns.add({
      ...run('games/a', '2026-10-29T10:00:00.000Z'),
      trigger: 'cli',
      report: report('high'),
    })
    const tool = await store.auditRuns.add({
      ...run('tools/x', '2026-10-29T11:00:00.000Z'),
      trigger: 'cli',
      report: report('low'),
    })
    const app = setup(games)

    const list = (await (
      await app.request('/api/audit-runs', { headers: asGames })
    ).json()) as AuditRunList
    expect(list.runs.map((r) => r.repo.path)).toEqual(['games/a'])
    expect((await app.request(`/api/audit-runs/${tool.id}`, { headers: asGames })).status).toBe(403)
    const repos = (await (await app.request('/api/repos', { headers: asGames })).json()) as RepoList
    expect(repos.repos.map((r) => [r.repo.path, r.groups])).toEqual([['games/a', ['games']]])
    expect(
      (
        await send(
          app,
          'POST',
          '/api/audit-runs',
          run('games/a', '2026-10-29T12:00:00.000Z'),
          asGames,
        )
      ).status,
    ).toBe(403)
  })

  test('stores settings per scope, seals secrets and resolves for a repository', async () => {
    const app = setup()
    await send(app, 'PUT', '/api/settings', {
      key: 'llm.model',
      scope: { all: true },
      value: 'claude-sonnet-5-5',
    })
    await send(app, 'PUT', '/api/settings', {
      key: 'llm.model',
      scope: { groups: ['games'] },
      value: 'claude-opus-5-5',
    })
    const secret = await send(app, 'PUT', '/api/settings', {
      key: 'llm.apiKey',
      scope: { all: true },
      value: 'sk-secret',
    })
    expect(await secret.json()).toMatchObject({ value: null, secret: true })
    expect(JSON.stringify(await store.settings.list())).not.toContain('sk-secret')

    const bad = await send(app, 'PUT', '/api/settings', {
      key: 'audit.fix',
      scope: { all: true },
      value: 'yes',
    })
    expect(bad.status).toBe(400)
    expect(
      (await send(app, 'PUT', '/api/settings', { key: 'nope', scope: { all: true }, value: 1 }))
        .status,
    ).toBe(400)

    const list = (await (await app.request('/api/settings')).json()) as SettingList
    expect(list.definitions.find((d) => d.key === 'audit.upgrade')?.schema).toMatchObject({
      enum: ['major', 'minor', 'patch'],
    })
    expect(list.settings).toHaveLength(3)

    const resolved = (await (
      await app.request('/api/settings/resolve?repo=work:games/a')
    ).json()) as ResolvedSettings
    expect(resolved.groups).toEqual(['games'])
    expect(resolved.settings['llm.model']?.value).toBe('claude-opus-5-5')
    expect(resolved.settings['llm.apiKey']?.value).toBeNull()
  })

  test('limits setting writes to the caller scope', async () => {
    const app = setup(games)
    const own = await send(
      app,
      'PUT',
      '/api/settings',
      { key: 'llm.model', scope: { groups: ['games'] }, value: 'm' },
      asGames,
    )
    expect(own.status).toBe(200)
    const global = await send(
      app,
      'PUT',
      '/api/settings',
      { key: 'llm.model', scope: { all: true }, value: 'm' },
      asGames,
    )
    expect(global.status).toBe(403)
  })

  test('manages credentials without exposing secrets', async () => {
    const app = setup()
    const created = await send(app, 'POST', '/api/credentials', {
      name: 'GitLab bot',
      kind: 'other',
      url: 'https://gitlab.test',
      scope: { groups: ['games'] },
      secret: 'glpat-123',
    })
    expect(created.status).toBe(201)
    const view = (await created.json()) as CredentialView
    expect(JSON.stringify(view)).not.toContain('glpat-123')

    const list = (await (await app.request('/api/credentials')).json()) as CredentialList
    expect(list.credentials.map((c) => c.name)).toEqual(['GitLab bot'])
    const forGames = (await (
      await setup(games).request('/api/credentials', { headers: asGames })
    ).json()) as CredentialList
    expect(forGames.credentials).toHaveLength(1)
    expect(
      (await send(setup(games), 'DELETE', `/api/credentials/${view.id}`, undefined, asGames))
        .status,
    ).toBe(403)
    expect((await send(app, 'DELETE', `/api/credentials/${view.id}`)).status).toBe(204)
    expect((await send(app, 'POST', '/api/credentials', { name: 'x' })).status).toBe(400)
  })

  test('lists the models of an AI provider credential', async () => {
    const app = setup()
    const created = await send(app, 'POST', '/api/credentials', {
      name: 'Bedrock',
      kind: 'bedrock',
      url: 'https://bedrock.test',
      scope: { all: true },
      secret: 'unused',
      options: {
        region: 'eu-north-1',
        model: 'claude-opus-5-5',
        pricing: { 'claude-opus-5-5': { inputPerMTok: 5, outputPerMTok: 25 } },
      },
    })
    const view = (await created.json()) as CredentialView
    const response = await app.request(`/api/credentials/${view.id}/models`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      models: [
        {
          id: 'claude-opus-5-5',
          source: 'config',
          pricing: { inputPerMTok: 5, outputPerMTok: 25 },
        },
      ],
    })
  })

  test('activity requires global user rights', async () => {
    expect((await setup().request('/api/activity')).status).toBe(200)
    expect((await setup(games).request('/api/activity', { headers: asGames })).status).toBe(403)
  })

  test('routes auth endpoints to the provider and 404s unknown API paths', async () => {
    expect((await setup().request('/api/nope')).status).toBe(404)
    expect((await setup().request('/auth/none/anything')).status).toBe(404)
  })

  test('ingests analyses, renders reports and compares with the previous record', async () => {
    const app = setup()
    const ingest = (ref: string, bytes: number, createdAt: string) =>
      send(app, 'POST', '/api/analyses', {
        repo: { forge: 'work', path: 'games/a' },
        kind: 'size',
        ref,
        createdAt,
        data: { bytes },
      })

    const first = (await (
      await ingest('v1.0.0', 100, '2026-10-01T00:00:00.000Z')
    ).json()) as AnalysisSummary
    const second = await ingest('v1.1.0', 150, '2026-10-02T00:00:00.000Z')
    expect(second.status).toBe(201)
    const created = (await second.json()) as AnalysisSummary
    expect(created).toMatchObject({
      kind: 'size',
      label: 'Size',
      ref: 'v1.1.0',
      metrics: [{ value: 150 }],
    })

    const detail = (await (
      await app.request(`/api/analyses/${created.id}`)
    ).json()) as AnalysisDetail
    expect(detail.previous?.ref).toBe('v1.0.0')
    expect(detail.report.metrics[0]).toMatchObject({ value: 150, delta: 50, better: 'down' })
    const firstDetail = (await (
      await app.request(`/api/analyses/${first.id}`)
    ).json()) as AnalysisDetail
    expect(firstDetail.previous).toBeUndefined()

    const list = (await (
      await app.request('/api/analyses?repo=work:games/a&kind=size')
    ).json()) as AnalysisList
    expect(list.analyses.map((a) => a.ref)).toEqual(['v1.1.0', 'v1.0.0'])
    expect(await (await app.request('/api/analyses/kinds')).json()).toEqual({
      kinds: [{ kind: 'size', label: 'Size' }],
    })
  })

  test('validates analysis data against its kind', async () => {
    const app = setup()
    const post = (body: unknown) => send(app, 'POST', '/api/analyses', body)
    expect(
      (await post({ repo: { forge: 'work', path: 'games/a' }, kind: 'nope', data: {} })).status,
    ).toBe(400)
    expect(
      (await post({ repo: { forge: 'work', path: 'games/a' }, kind: 'size', data: { bytes: 'x' } }))
        .status,
    ).toBe(400)
    expect(
      (
        await send(
          setup(games),
          'POST',
          '/api/analyses',
          { repo: { forge: 'work', path: 'games/a' }, kind: 'size', data: { bytes: 1 } },
          asGames,
        )
      ).status,
    ).toBe(403)
  })

  test('turns suggested changes into a patch or a merge request', async () => {
    const app = setup()
    const created = (await (
      await send(app, 'POST', '/api/analyses', {
        repo: { forge: 'work', path: 'games/a' },
        kind: 'size',
        data: { bytes: 1 },
      })
    ).json()) as AnalysisSummary

    const patch = (await (
      await send(app, 'POST', `/api/analyses/${created.id}/changes`, {
        ids: ['rename'],
        mode: 'patch',
      })
    ).json()) as { patch: string; applied: string[] }
    expect(patch.applied).toEqual(['rename'])
    expect(patch.patch).toContain('-const max = 1\n+const MAX = 1')

    const mr = (await (
      await send(app, 'POST', `/api/analyses/${created.id}/changes`, {
        ids: ['rename'],
        mode: 'merge-request',
      })
    ).json()) as { mergeRequest: { url: string } }
    expect(mr.mergeRequest.url).toBe('https://forge.test/mr/3')
    expect(openedRequests).toHaveLength(1)
    expect((await store.activity.list()).map((e) => e.action)).toContain(
      'changes.merge_request_opened',
    )

    expect(
      (
        await send(app, 'POST', `/api/analyses/${created.id}/changes`, {
          ids: ['nope'],
          mode: 'patch',
        })
      ).status,
    ).toBe(400)
  })
})
