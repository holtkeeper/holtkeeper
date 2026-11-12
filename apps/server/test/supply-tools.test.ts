import { beforeEach, describe, expect, test } from 'bun:test'

import type { Grant, Principal } from '@holtkeeper/access'
import { recordMetrics } from '@holtkeeper/analyzer'
import type { FindingsResponse, LicensesOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { type LicensedPackage, type LicensesData, licensesMetrics } from '@holtkeeper/licenses'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import type { AuditReport, Finding } from '@holtkeeper/vuln'

import { builtinAnalyses } from '../src/analyses.ts'
import { createApiCatalog } from '../src/api-surface/catalog.ts'
import { createUsageIndex } from '../src/api-surface/usages.ts'
import { createApp } from '../src/app.ts'
import { agentCatalogContext, mcpToolsets } from '../src/tools/registry.ts'
import { supplyTools, supplyToolsAccess } from '../src/tools/repos.ts'

const config = parseConfig({
  forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
  groups: {
    web: { forge: 'work', include: ['acme/web-*'] },
    pay: { forge: 'work', include: ['acme/pay-*'] },
  },
})

const grants: Record<string, Grant[]> = {
  admin: [{ scope: { all: true }, actions: ['*'] }],
  web: [{ scope: { groups: ['web'] }, actions: ['audits:read', 'analyses:read'] }],
}
const principalOf = (role: string): Principal => ({
  id: `header:${role}`,
  name: role,
  provider: 'header',
  grants: grants[role] ?? [],
})
const as = (role: string) => ({ 'x-forwarded-user': role, 'x-forwarded-groups': role })

const now = () => new Date('2026-11-10T12:00:00.000Z')
const kinds = new Map(builtinAnalyses.map((kind) => [kind.kind, kind]))

const finding = (id: string, pkg: string, version: string, extra: Partial<Finding> = {}) => ({
  id,
  aliases: [],
  summary: `Widget overflow in ${pkg}`,
  severity: 'high' as const,
  url: `https://osv.test/${id}`,
  package: { name: pkg, version, ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['9.9.9'],
  ...extra,
})

const report = (findings: Finding[]): AuditReport => ({
  scanner: 'osv-scanner',
  findings,
  ignored: [],
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
})

const pkg = (
  name: string,
  verdict: LicensedPackage['verdict'],
  licenses: string[],
): LicensedPackage => ({
  name,
  version: '1.0.0',
  ecosystem: 'npm',
  sources: ['package-lock.json'],
  licenses,
  verdict,
  ...(verdict === 'denied' || verdict === 'unlisted' ? { culprits: licenses } : {}),
})

const scan = (packages: LicensedPackage[]): LicensesData => ({
  tool: { name: 'osv-scanner', version: '2.7.0' },
  policy: { allow: ['MIT'], deny: ['GPL-*'], ignore: [] },
  packages,
})

let store: Store
let app: ReturnType<typeof createApp>
let supplyFor: ReturnType<typeof supplyToolsAccess>

const audit = async (path: string, findings: Finding[]) => {
  const repo = { forge: 'work', path }
  const createdAt = '2026-11-06T00:00:00.000Z'
  const data = report(findings)
  const metrics = await recordMetrics(store.analyses, kinds.get('audit'), {
    repo,
    createdAt,
    data,
  })
  await store.analyses.add({ repo, kind: 'audit', createdAt, data, ...(metrics && { metrics }) })
}

const licenses = (path: string, data: LicensesData) =>
  store.analyses.add({
    repo: { forge: 'work', path },
    kind: 'licenses',
    createdAt: '2026-11-06T00:00:00.000Z',
    data,
    metrics: licensesMetrics(data),
  })

const http = async <T>(path: string, role: string) => {
  const response = await app.request(path, { headers: as(role) })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

const run = async (name: string, role: string, input: Record<string, unknown> = {}) => {
  const tool = supplyTools(supplyFor(principalOf(role))).find((item) => item.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(input, { dir: '.', signal: new AbortController().signal })
}

const groupLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('- **'))
    .map((line) => /^- \*\*(\S+)\*\* (\S+)/.exec(line)?.slice(1, 3).join(' '))

const repoLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('  - `'))
    .map((line) => /`([^`]+)`/.exec(line)?.[1])

const section = (text: string, heading: string) => {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => line.startsWith('- '))
}

beforeEach(async () => {
  store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  app = createApp({
    config,
    auth: headerAuth({ roles: grants }),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: builtinAnalyses,
    now,
  })
  supplyFor = supplyToolsAccess({ config, store, analyses: builtinAnalyses, now })

  await audit('acme/web-shop', [
    finding('GHSA-1', 'some-lib', '1.0.1'),
    finding('GHSA-2', 'other-lib', '2.0.0', { severity: 'critical' }),
  ])
  await audit('acme/web-admin', [finding('GHSA-1', 'some-lib', '1.0.0')])
  await audit('acme/pay-core', [finding('GHSA-3', 'foo-util', '3.0.0', { severity: 'low' })])

  await licenses(
    'acme/web-shop',
    scan([pkg('widget-core', 'allowed', ['MIT']), pkg('gizmo', 'denied', ['GPL-3.0-only'])]),
  )
  await licenses('acme/pay-core', scan([pkg('sprocket', 'unlisted', ['MPL-2.0'])]))
})

describe('security_findings', () => {
  test('answers the groups and rows of GET /api/audits/findings', async () => {
    const body = await http<FindingsResponse>('/api/audits/findings', 'admin')
    expect(await supplyFor(principalOf('admin')).findings()).toEqual(body)

    const text = await run('security_findings', 'admin')
    expect(text).toStartWith('# 3 findings: 1 critical, 1 high, 0 medium, 1 low, 0 unknown')
    expect(groupLines(text)).toEqual(
      body.groups.map((group) => `${group.advisory} ${group.package}`),
    )
    expect(repoLines(text)).toEqual(
      body.groups.flatMap((group) => group.repos.map((repo) => repo.repo)),
    )
  })

  test('narrows by repository, severity and status like the endpoint', async () => {
    const one = await http<FindingsResponse>(
      '/api/audits/findings?repo=work:acme/web-admin',
      'admin',
    )
    const text = await run('security_findings', 'admin', { repo: 'work:acme/web-admin' })
    expect(groupLines(text)).toEqual(
      one.groups.map((group) => `${group.advisory} ${group.package}`),
    )

    expect(groupLines(await run('security_findings', 'admin', { severity: 'critical' }))).toEqual([
      'GHSA-2 other-lib',
    ])
    expect(await run('security_findings', 'admin', { status: 'fixing' })).toContain(
      'No finding matches.',
    )
  })

  test('a narrow grant sees only the repositories it may read audits of', async () => {
    const body = await http<FindingsResponse>('/api/audits/findings', 'web')
    const text = await run('security_findings', 'web')
    expect(groupLines(text)).toEqual(['GHSA-2 other-lib', 'GHSA-1 some-lib'])
    expect(groupLines(text)).toEqual(
      body.groups.map((group) => `${group.advisory} ${group.package}`),
    )
    expect(text).not.toContain('pay-core')
    expect(await run('security_findings', 'web', { repo: 'work:acme/pay-core' })).toContain(
      '# 0 findings',
    )
  })
})

describe('license_overview', () => {
  test('answers the rows and violations of GET /api/licenses', async () => {
    const body = await http<LicensesOverview>('/api/licenses', 'admin')
    expect(await supplyFor(principalOf('admin')).licenses()).toEqual(body)

    const text = await run('license_overview', 'admin')
    expect(text).toStartWith(
      `# Licenses across ${body.kpi.repos} repositories: ${body.kpi.packages} packages, ${body.kpi.denied} denied, ${body.kpi.review} need review`,
    )
    expect(section(text, 'Repositories').map((line) => /`([^`]+)`/.exec(line)?.[1])).toEqual(
      body.repos.map((row) => row.repo),
    )
    expect(section(text, 'Violations').map((line) => /\*\*(\S+)\*\*/.exec(line)?.[1])).toEqual(
      body.violations.map((violation) => violation.package),
    )
  })

  test('narrows to one repository', async () => {
    const text = await run('license_overview', 'admin', { repo: 'work:acme/pay-core' })
    expect(text).toStartWith('# Licenses of `work:acme/pay-core`')
    expect(section(text, 'Violations')).toEqual([
      '- **sprocket** (npm) unlisted: MPL-2.0, versions 1.0.0, because of MPL-2.0; in `work:acme/pay-core`',
    ])
  })

  test('a narrow grant sees only the repositories it may read analyses of', async () => {
    const body = await http<LicensesOverview>('/api/licenses', 'web')
    const text = await run('license_overview', 'web')
    expect(body.repos.map((row) => row.repo)).toEqual(['work:acme/web-shop'])
    expect(section(text, 'Repositories').map((line) => /`([^`]+)`/.exec(line)?.[1])).toEqual([
      'work:acme/web-shop',
    ])
    expect(text).not.toContain('sprocket')
    expect(body.policy).toBeUndefined()
    expect(text).not.toContain('Policy')
    expect(await run('license_overview', 'admin')).toContain('Policy')
    expect(await run('license_overview', 'web', { repo: 'work:acme/pay-core' })).toBe(
      'No license scan of `work:acme/pay-core` you may read.',
    )
  })
})

const base = () => ({
  catalog: createApiCatalog({ analyses: store.analyses }),
  usages: createUsageIndex({ analyses: store.analyses }),
  store,
})

const toolNames = (toolsets: ReturnType<typeof mcpToolsets>) =>
  toolsets.flatMap((toolset) => toolset.tools.map((tool) => tool.name))

describe('registration', () => {
  test('the MCP catalog toolset offers the tools only with supply', () => {
    const context = {
      ...base(),
      knowledge: { store, canReadScope: () => true, repoOf: () => undefined, actor: 'x', now },
      canRead: () => true,
      canReadAnalyses: () => true,
      canReadAudits: () => true,
    }
    expect(toolNames(mcpToolsets(context))).not.toContain('security_findings')
    expect(toolNames(mcpToolsets({ ...context, supply: supplyFor(principalOf('web')) }))).toContain(
      'license_overview',
    )
  })

  test('chat gets the requester’s supply, internal agents none', () => {
    const options = {
      ...base(),
      repo: { forge: 'work', path: 'acme/web-shop', groups: ['web'] },
      targetOf: (repo: { forge: string; path: string }) => ({ ...repo, groups: [] }),
      policy: 'off' as const,
      supply: supplyFor,
      now,
    }
    expect(agentCatalogContext(options).supply).toBeUndefined()
    expect(agentCatalogContext({ ...options, requester: principalOf('web') }).supply).toBeDefined()
  })
})
