import { beforeEach, describe, expect, test } from 'bun:test'

import type {
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  SecretReportList,
  SecretReportView,
  SecretReportsLicense,
} from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { type HoltkeeperConfig, parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const baseConfig = parseConfig({
  forges: {
    work: { kind: 'gitlab', url: 'https://gitlab.test', create: () => ({}) as never },
  },
  teams: { widgets: { owns: ['work:widgets/*'] } },
})

// Only `secretReports` of the server section matters here; the rest is never read.
const configWith = (secretReports?: boolean): HoltkeeperConfig =>
  secretReports === undefined
    ? baseConfig
    : { ...baseConfig, server: { secretReports } as NonNullable<HoltkeeperConfig['server']> }

const auth = headerAuth({
  roles: {
    admin: [{ scope: { all: true }, actions: ['*'] }],
    dev: [{ scope: { teams: ['widgets'] }, actions: ['repos:read', 'analyses:read'] }],
  },
})
const asAdmin = { 'x-forwarded-user': 'jane', 'x-forwarded-groups': 'admin' }
const asDev = { 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'dev' }

let store: Store
let app: ReturnType<typeof createApp>
const now = new Date('2026-11-16T09:41:00.000Z')

const build = (secretReports?: boolean) => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config: configWith(secretReports),
    auth,
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now: () => now,
  })
}

beforeEach(() => build())

const json = (method: string, body: unknown, headers: Record<string, string>) => ({
  method,
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const tokenFor = async (headers: Record<string, string>, secretReports?: string) => {
  const response = await app.request(
    '/api/api-surface/mcp/tokens',
    json('POST', { name: 'laptop', ...(secretReports && { secretReports }) }, headers),
  )
  expect(response.status).toBe(201)
  const created = (await response.json()) as CreateMcpTokenResult
  return { ...created, bearer: { authorization: `Bearer ${created.secret}` } }
}

const rpc = async (method: string, params: unknown, headers: Record<string, string>) => {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'claude-code/2.1.0 (test)',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { result: unknown }).result
}

const toolNames = async (headers: Record<string, string>) =>
  ((await rpc('tools/list', {}, headers)) as { tools: { name: string }[] }).tools.map(
    (tool) => tool.name,
  )

const report = async (args: Record<string, unknown>, headers: Record<string, string>) =>
  (await rpc('tools/call', { name: 'report_secret_exposure', arguments: args }, headers)) as {
    content: { text: string }[]
    isError?: boolean
  }

const listReports = async (headers: Record<string, string> = asAdmin) => {
  const response = await app.request('/api/secret-reports', { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as SecretReportList
}

const valid = {
  kind: 'api-key',
  identifier: 'WIDGET_API_KEY',
  masked: 'wk_l…(40)',
  channel: 'chat',
  repo: 'work:widgets/factory',
  circumstances: 'A .env file was printed while debugging the widget importer.',
}

describe('tokens', () => {
  test('report under their owner’s name by default and tell clients the license', async () => {
    const { token } = await tokenFor(asDev)
    expect(token.secretReports).toBe('named')
    const list = (await (
      await app.request('/api/api-surface/mcp/tokens', { headers: asDev })
    ).json()) as McpTokenList
    expect(list.secretReports).toEqual({
      defaultMode: 'named',
      licenseName: 'Holtkeeper Secret Reports License',
    })
  })

  test('the reporting choice changes without an audit trace and off removes the tool', async () => {
    const { token, bearer } = await tokenFor(asDev)
    expect(await toolNames(bearer)).toContain('report_secret_exposure')
    const changed = await app.request(
      `/api/api-surface/mcp/tokens/${token.id}`,
      json('PATCH', { secretReports: 'off' }, asDev),
    )
    expect(changed.status).toBe(204)
    expect(await toolNames(bearer)).not.toContain('report_secret_exposure')
    const { events } = await store.audit.list({})
    expect(JSON.stringify(events)).not.toContain('"off"')
    expect(events.map((event) => event.action)).toEqual(['mcp_token.create'])

    expect(
      (
        await app.request(
          `/api/api-surface/mcp/tokens/${token.id}`,
          json('PATCH', { secretReports: 'named' }, asAdmin),
        )
      ).status,
    ).toBe(404)
  })

  test('the license is readable by anyone signed in', async () => {
    const response = await app.request('/api/secret-reports/license', { headers: asDev })
    const license = (await response.json()) as SecretReportsLicense
    expect(license.name).toBe('Holtkeeper Secret Reports License')
    expect(license.text).toContain('No sanctions')
  })
})

describe('report_secret_exposure', () => {
  test('a named report carries the reporter and is audited', async () => {
    const { bearer } = await tokenFor(asDev)
    const answer = await report(valid, bearer)
    expect(answer.isError).toBeUndefined()
    expect(answer.content[0]?.text).toContain("under the user's name")
    const { reports, canWrite } = await listReports()
    expect(canWrite).toBe(true)
    expect(reports).toEqual([
      expect.objectContaining({
        ...valid,
        status: 'new',
        reportedAt: now.toISOString(),
        reporter: { id: 'header:bob', name: 'bob' },
        repeats: 0,
      }),
    ])
    const { events } = await store.audit.list({})
    expect(events.map((event) => event.action)).toContain('secret_report.create')
  })

  test('an anonymous report leaves no trace of its sender', async () => {
    const { bearer, token } = await tokenFor(asDev, 'anonymous')
    const answer = await report(valid, bearer)
    expect(answer.content[0]?.text).toContain('anonymously')
    const [stored] = (await listReports()).reports
    expect(stored?.reporter).toBeUndefined()
    expect(stored?.reportedAt).toBe('2026-11-16T00:00:00.000Z')

    const usage = (await (
      await app.request('/api/api-surface/mcp/usage?days=7', { headers: asAdmin })
    ).json()) as McpUsageOverview
    expect(usage.people).toEqual([])
    expect(usage.recent).toEqual([])
    const trail = JSON.stringify((await store.audit.list({})).events)
    expect(trail).not.toContain('secret_report')
    expect(trail).not.toContain(stored!.id)
    expect(token.secretReports).toBe('anonymous')
  })

  test('reports about anything but the organization are refused and not stored', async () => {
    const { bearer } = await tokenFor(asDev)
    const outside = await report({ ...valid, repo: 'work:elsewhere/tool' }, bearer)
    expect(outside.isError).toBe(true)
    expect(outside.content[0]?.text).toContain('Not reported')
    const service = await report(
      { ...valid, repo: undefined, service: 'api.personal-thing.test' },
      bearer,
    )
    expect(service.isError).toBe(true)
    const forgeHost = await report(
      { ...valid, repo: undefined, service: 'https://gitlab.test' },
      bearer,
    )
    expect(forgeHost.isError).toBeUndefined()
    expect((await listReports()).reports).toHaveLength(1)
  })

  test('services listed in security.secretReports count as the organization', async () => {
    await store.settings.put({
      id: 'secret-reports',
      key: 'security.secretReports',
      scope: { all: true },
      value: { services: ['example.com'] },
      secret: false,
      updatedAt: now.toISOString(),
    })
    const { bearer } = await tokenFor(asDev)
    const answer = await report(
      { ...valid, repo: undefined, service: 'payments.example.com' },
      bearer,
    )
    expect(answer.isError).toBeUndefined()
  })

  test('a report holding the value is refused before anything is stored', async () => {
    const { bearer } = await tokenFor(asDev)
    const value = 'glpat-abcdefghij0123456789'
    const answer = await report({ ...valid, circumstances: `Pasted ${value} by mistake.` }, bearer)
    expect(answer.isError).toBe(true)
    expect(answer.content[0]?.text).not.toContain(value)
    expect((await listReports()).reports).toEqual([])
  })
})

describe('/api/secret-reports', () => {
  test('needs credentials:read on everything and records who changed the status', async () => {
    const { bearer } = await tokenFor(asDev)
    await report(valid, bearer)
    expect((await app.request('/api/secret-reports', { headers: asDev })).status).toBe(403)
    const [stored] = (await listReports()).reports
    const response = await app.request(
      `/api/secret-reports/${stored!.id}`,
      json('PATCH', { status: 'rotated', note: 'Rotated in the vault' }, asAdmin),
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as SecretReportView).toMatchObject({
      status: 'rotated',
      note: 'Rotated in the vault',
      updatedBy: 'header:jane',
    })
    expect(
      (
        await app.request(
          `/api/secret-reports/${stored!.id}`,
          json('PATCH', { status: 'rotated' }, asDev),
        )
      ).status,
    ).toBe(403)
  })

  test('server.secretReports: false removes the tool, the page and the choice', async () => {
    build(false)
    const { bearer, token } = await tokenFor(asDev)
    expect(await toolNames(bearer)).not.toContain('report_secret_exposure')
    expect((await app.request('/api/secret-reports', { headers: asAdmin })).status).toBe(404)
    const list = (await (
      await app.request('/api/api-surface/mcp/tokens', { headers: asDev })
    ).json()) as McpTokenList
    expect(list.secretReports).toBeUndefined()
    expect(token.secretReports).toBe('named')
  })
})
