import { beforeEach, describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { recordMetrics } from '@holtkeeper/analyzer'
import { noAuth } from '@holtkeeper/auth-none'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { builtinSettings } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'
import type { AuditReport, Finding } from '@holtkeeper/vuln'
import { securityAlertsDefinition } from '@holtkeeper/vuln-triage'

import { builtinAnalyses } from '../src/analyses.ts'
import type { ServerDeps } from '../src/context.ts'
import { type SecurityAlerts, createSecurityAlerts } from '../src/security-alerts.ts'
import type { SlackMessageBody, SlackPoster } from '../src/slack/client.ts'

const CHANNEL = 'C0123WIDGET'
const START = Date.parse('2026-11-12T09:00:00.000Z')

interface Sent extends SlackMessageBody {
  channel: string
  ts: string
  threadTs?: string
  kind: 'post' | 'update'
}

let store: Store
let deps: ServerDeps
let clock: number
let sent: Sent[]
let triaged: string[]
let failAgent: boolean
let refusePost: string | undefined
let alerts: SecurityAlerts

const vault = aesVault('v'.repeat(32))
const audit = builtinAnalyses.find((kind) => kind.kind === 'audit')

const poster: SlackPoster = {
  post: async ({ channel, threadTs, ...message }) => {
    if (refusePost) return { ok: false, error: refusePost }
    const ts = `1700000000.00${sent.length + 100}`
    sent.push({ kind: 'post', channel, ts, ...(threadTs && { threadTs }), ...message })
    return { ok: true, channel, ts }
  },
  update: async ({ channel, ts, ...message }) => {
    sent.push({ kind: 'update', channel, ts, ...message })
    return { ok: true, channel, ts }
  },
  permalink: async ({ channel, ts }) => `https://acme.slack.test/archives/${channel}/p${ts}`,
}

/** Urgent when the advisory summary says "injection". */
const agent: Agent = {
  name: 'fake',
  run: async (task: AgentTask) => {
    const id = /"id": "([^"]+)"/u.exec(task.prompt)?.[1] ?? '?'
    triaged.push(id)
    if (failAgent) throw new Error('weekly AI budget reached')
    const urgent = task.prompt.includes('injection')
    return {
      text: '',
      turns: 1,
      output: {
        urgent,
        category: urgent ? 'code-execution' : 'other',
        reason: urgent ? 'Template injection runs attacker code on the server.' : 'Build only.',
      },
    } as never
  },
}

const finding = (id: string, pkg: string, extra: Partial<Finding> = {}): Finding => ({
  id,
  aliases: [],
  summary: `Overflow in ${pkg}`,
  severity: 'critical',
  url: `https://osv.test/${id}`,
  package: { name: pkg, version: '1.0.0', ecosystem: 'npm' },
  source: 'package-lock.json',
  fixedVersions: ['1.0.1'],
  ...extra,
})

const injection = () =>
  finding('GHSA-aaaa-0001', 'widget-render', { summary: 'Template injection in widget-render' })
const buildOnly = () => finding('GHSA-aaaa-0002', 'widget-bundler')
const highOnly = () =>
  finding('GHSA-aaaa-0003', 'widget-cli', { severity: 'high', summary: 'Command injection' })
const malware = () =>
  finding('MAL-2026-0001', 'shape-utilz', {
    severity: 'unknown',
    summary: 'Malicious code in shape-utilz (npm)',
  })

const ingest = async (path: string, findings: Finding[], ignored: AuditReport['ignored'] = []) => {
  const repo = { forge: 'work', path }
  const data: AuditReport = {
    scanner: 'osv-scanner',
    findings,
    ignored,
    expired: [],
    fixes: [],
    resolved: [],
    changedFiles: [],
  }
  const createdAt = new Date(clock).toISOString()
  const metrics = await recordMetrics(store.analyses, audit, { repo, createdAt, data })
  await store.analyses.add({
    repo,
    kind: 'audit',
    createdAt,
    data,
    ...(metrics ? { metrics } : {}),
  })
}

const configure = (value: Record<string, unknown> = {}) =>
  store.settings.put({
    id: 'security-alerts',
    key: 'security.alerts',
    scope: { all: true },
    value: { channels: [CHANNEL], ...value },
    secret: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  })

const tick = (minutes: number) => {
  clock += minutes * 60_000
}

const posts = () => sent.filter((entry) => entry.kind === 'post' && !entry.threadTs)
const replies = () => sent.filter((entry) => entry.threadTs)
const updates = () => sent.filter((entry) => entry.kind === 'update')
const shown = (entry: Sent | undefined) => JSON.stringify(entry?.blocks ?? [])

beforeEach(async () => {
  clock = START
  sent = []
  triaged = []
  failAgent = false
  refusePost = undefined
  store = memoryStore()
  deps = {
    config: parseConfig({
      server: {
        auth: noAuth(),
        store,
        vaultKey: 'v'.repeat(32),
        publicUrl: 'https://holtkeeper.test',
      },
      forges: {
        work: { kind: 'gitlab', url: 'https://git.acme.test', create: () => ({}) as never },
      },
    }),
    auth: noAuth(),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: [...builtinSettings, securityAlertsDefinition],
    analyses: builtinAnalyses,
    analyzers: [],
    slackPoster: () => poster,
    automaticAgentFor: async () => agent,
    now: () => new Date(clock),
  }
  await store.kv?.set('chat:slack:connection', {
    botToken: await vault.seal('xoxb-widget'),
    signingSecret: await vault.seal('shape-secret'),
    connectedAt: new Date(START).toISOString(),
    connectedBy: 'header:jane',
  })
  const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
  alerts = createSecurityAlerts(deps, { log: () => {}, fetch: notFound })
})

describe('security alerts', () => {
  test('without channels nothing is triaged or posted', async () => {
    await ingest('g/app', [injection(), malware()])
    await alerts.sweep()
    tick(60)
    await alerts.sweep()
    expect(triaged).toEqual([])
    expect(sent).toEqual([])
  })

  test('posts urgent advisories once per package, grouping repositories, after the window', async () => {
    await configure()
    await ingest('g/app', [injection(), buildOnly(), highOnly(), malware()])
    await ingest('g/shop', [injection()])
    await alerts.sweep()
    // Malware needs no AI; only critical and unknown advisories are asked about, each once.
    expect(triaged.toSorted()).toEqual(['GHSA-aaaa-0001', 'GHSA-aaaa-0002'])
    expect(sent).toEqual([])

    tick(30)
    await alerts.sweep()
    expect(posts()).toHaveLength(2)
    const render = posts().find((entry) => entry.text.includes('widget-render'))
    expect(render?.channel).toBe(CHANNEL)
    expect(render?.text).toContain('2 repositories')
    expect(shown(render)).toContain('<https://git.acme.test/g/app|g/app>')
    expect(shown(render)).toContain('<https://git.acme.test/g/shop|g/shop>')
    expect(shown(render)).toContain('Template injection runs attacker code on the server.')
    expect(shown(render)).toContain('https://holtkeeper.test/supply/security')
    const mal = posts().find((entry) => entry.text.includes('shape-utilz'))
    expect(shown(mal)).toContain('Malicious package')
    const posted = Object.values((await alerts.state()).alerts).filter(
      (alert) => alert.status === 'posted',
    )
    expect(
      posted.map((alert) => alert.posts[0]?.url?.startsWith('https://acme.slack.test/')),
    ).toEqual([true, true])

    tick(30)
    await alerts.sweep()
    expect(sent).toHaveLength(2)
    expect(triaged).toHaveLength(2)
  })

  test('a repository found later joins the message and its thread; gone everywhere resolves it', async () => {
    await configure({ windowMinutes: 0 })
    await ingest('g/app', [injection()])
    await alerts.sweep()
    expect(posts()).toHaveLength(1)
    const ts = posts()[0]?.ts

    tick(60)
    await ingest('g/shop', [injection()])
    await alerts.sweep()
    expect(posts()).toHaveLength(1)
    expect(updates().at(-1)?.ts).toBe(ts)
    expect(shown(updates().at(-1))).toContain('g/shop')
    expect(replies()).toHaveLength(1)
    expect(replies()[0]?.threadTs).toBe(ts)
    expect(replies()[0]?.text).toContain('Also found in')
    expect(replies()[0]?.text).toContain('g/shop')
    expect(replies()[0]?.text).not.toContain('g/app')

    tick(60)
    await ingest('g/app', [])
    await ingest('g/shop', [])
    await alerts.sweep()
    expect(shown(updates().at(-1))).toContain('Resolved')
    const count = sent.length
    await alerts.sweep()
    expect(sent).toHaveLength(count)

    tick(60)
    await ingest('g/app', [injection()])
    await alerts.sweep()
    expect(posts()).toHaveLength(1)
    expect(shown(updates().at(-1))).not.toContain('Resolved')
    expect(replies().at(-1)?.text).toContain('Found again in')
    expect(triaged).toHaveLength(1)
  })

  test('allowlisted repositories are left out', async () => {
    await configure({ windowMinutes: 0 })
    await ingest(
      'g/app',
      [],
      [{ finding: injection(), entry: { id: 'GHSA-aaaa-0001', reason: 'not reachable' } }],
    )
    await alerts.sweep()
    expect(triaged).toEqual([])
    expect(sent).toEqual([])
  })

  test('a failed triage is retried later; nothing is posted meanwhile', async () => {
    await configure({ windowMinutes: 0 })
    await ingest('g/app', [injection()])
    failAgent = true
    await alerts.sweep()
    tick(10)
    await alerts.sweep()
    expect(triaged).toHaveLength(1)
    expect(sent).toEqual([])

    failAgent = false
    tick(60)
    await alerts.sweep()
    expect(triaged).toHaveLength(2)
    expect(posts()).toHaveLength(1)
  })

  test('a refused post is tried again', async () => {
    await configure({ windowMinutes: 0 })
    await ingest('g/app', [malware()])
    refusePost = 'not_in_channel'
    await alerts.sweep()
    expect(sent).toEqual([])
    expect((await alerts.state()).alerts['MAL-2026-0001|npm|shape-utilz']?.postAttempts).toBe(1)

    refusePost = undefined
    tick(2)
    await alerts.sweep()
    expect(posts()).toHaveLength(1)
  })

  test('the severities setting widens what is triaged', async () => {
    await configure({ windowMinutes: 0, severities: ['high'] })
    await ingest('g/app', [injection(), highOnly()])
    await alerts.sweep()
    expect(triaged).toEqual(['GHSA-aaaa-0003'])
    expect(posts()).toHaveLength(1)
    expect(posts()[0]?.text).toContain('widget-cli')
  })
})
