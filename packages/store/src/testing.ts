import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { AuditReport } from '@holtkeeper/vuln'

import { ExternalAccountConflictError } from './accounts.ts'
import { AUDIT_GENESIS_HASH, auditHash } from './audit.ts'
import type {
  AiUsageRecord,
  AuditEventInput,
  AuditRun,
  CiJobRecord,
  ExternalAccount,
  KnowledgeEntryInput,
  KnowledgeFilter,
  NewJob,
  Store,
  StoredCredential,
  User,
} from './types.ts'

const emptyReport: AuditReport = {
  scanner: 'test',
  findings: [],
  ignored: [],
  expired: [],
  fixes: [],
  resolved: [],
  changedFiles: [],
}

const run = (path: string, finishedAt: string): Omit<AuditRun, 'id'> => ({
  repo: { forge: 'work', path },
  trigger: 'cli',
  startedAt: finishedAt,
  finishedAt,
  report: emptyReport,
})

const record = (kind: string, path: string, createdAt: string, ref?: string) => ({
  repo: { forge: 'work', path },
  kind,
  createdAt,
  ...(ref ? { ref } : {}),
  data: { kind, nested: { list: [1, 2] } },
})

const user = (id: string, overrides: Partial<User> = {}): User => ({
  id,
  name: id,
  grants: [{ scope: { repos: ['games/**'] }, actions: ['audits:read'] }],
  disabled: false,
  sessionVersion: 0,
  createdAt: '2026-10-29T00:00:00.000Z',
  ...overrides,
})

const job = (path: string, createdAt: string, overrides: Partial<NewJob> = {}): NewJob => ({
  analyzer: 'bundle',
  repo: { forge: 'work', path },
  trigger: 'manual',
  createdAt,
  ...overrides,
})

const knowledgeEntry = (
  id: string,
  overrides: Partial<KnowledgeEntryInput> = {},
): KnowledgeEntryInput => ({
  id,
  title: 'Prefer Vitest over Jest',
  body: 'We **decided** to use Vitest.',
  kind: 'convention',
  scope: { groups: ['games'] },
  topics: ['testing'],
  appliesTo: ['tests', 'review'],
  packages: [{ ecosystem: 'npm', name: 'vitest', from: '>=1 <2' }],
  status: 'accepted',
  source: 'agent',
  author: 'agent:review',
  evidence: [{ label: 'MR', url: 'https://forge.test/mr/1' }],
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
  updatedBy: 'agent:review',
  ...overrides,
})

const usage = (overrides: Partial<Omit<AiUsageRecord, 'id'>> = {}): Omit<AiUsageRecord, 'id'> => ({
  at: '2026-10-01T10:00:00.000Z',
  repo: { forge: 'work', path: 'games/slots' },
  groups: ['games'],
  taskKind: 'review',
  actor: 'jane',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 200,
  cacheWriteTokens: 10,
  costUsd: 0.1,
  costSource: 'reported',
  durationMs: 1000,
  turns: 2,
  outcome: 'ok',
  ...overrides,
})

const auditInput = (minute: number, overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  at: `2026-10-30T09:${String(minute).padStart(2, '0')}:00.000Z`,
  actor: { id: 'alice', name: 'Alice', provider: 'users' },
  via: 'ui',
  action: 'credential.update',
  target: { type: 'credential', id: 'c1' },
  outcome: 'ok',
  status: 200,
  request: { method: 'PATCH', path: '/api/credentials/c1', route: '/api/credentials/:id' },
  changes: [{ field: 'name', before: 'a', after: 'b' }],
  ...overrides,
})

const externalAccount = (
  id: string,
  overrides: Partial<ExternalAccount> = {},
): ExternalAccount => ({
  id,
  userId: 'u1',
  provider: 'gitlab:work',
  externalId: id.replace(/\D/g, '') || '1',
  verification: 'admin',
  linkedBy: 'root',
  linkedAt: '2026-10-30T09:00:00.000Z',
  ...overrides,
})

const ciJob = (
  path: string,
  jobId: number,
  createdAt: string,
  overrides: Partial<CiJobRecord> = {},
): CiJobRecord => ({
  repo: { forge: 'work', path },
  jobId,
  pipelineId: 100 + jobId,
  name: 'test',
  stage: 'test',
  status: 'success',
  createdAt,
  allowFailure: false,
  webUrl: `https://git/${path}/-/jobs/${jobId}`,
  ...overrides,
})

const t = (minute: number) => `2026-10-30T10:${String(minute).padStart(2, '0')}:00.000Z`

const leaseAt = (seconds: number) =>
  new Date(Date.parse('2026-10-30T10:00:00.000Z') + seconds * 1000)

/**
 * The behavior every `Store` implementation must have. Call it from the implementation's tests:
 * `describeStoreContract('sqlite', () => sqliteStore({ path: ':memory:' }))`.
 */
export function describeStoreContract(name: string, create: () => Store | Promise<Store>) {
  describe(`${name} store contract`, () => {
    let store: Store
    beforeEach(async () => {
      store = await create()
    })
    afterEach(async () => {
      await store.close()
    })

    test('audit runs: add, get, list newest first with filters and limit', async () => {
      const a = await store.auditRuns.add(run('games/a', '2026-10-01T00:00:00.000Z'))
      await store.auditRuns.add(run('games/b', '2026-10-03T00:00:00.000Z'))
      await store.auditRuns.add(run('games/a', '2026-10-02T00:00:00.000Z'))

      expect(a.id).toBeString()
      expect(await store.auditRuns.get(a.id)).toEqual(a)
      expect(await store.auditRuns.get('missing')).toBeUndefined()
      const all = await store.auditRuns.list()
      expect(all.map((r) => r.finishedAt.slice(8, 10))).toEqual(['03', '02', '01'])
      const filtered = await store.auditRuns.list({
        repo: { forge: 'work', path: 'games/a' },
        limit: 1,
      })
      expect(filtered.map((r) => r.finishedAt.slice(8, 10))).toEqual(['02'])
      const older = await store.auditRuns.list({ before: '2026-10-02T00:00:00.000Z' })
      expect(older.map((r) => r.finishedAt.slice(8, 10))).toEqual(['01'])
    })

    test('audit runs: reports round-trip intact', async () => {
      const report: AuditReport = {
        ...emptyReport,
        findings: [
          {
            id: 'GHSA-1',
            aliases: ['CVE-1'],
            summary: 's',
            severity: 'high',
            url: 'u',
            package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
            source: 'package-lock.json',
            fixedVersions: ['4.17.21'],
          },
        ],
      }
      const stored = await store.auditRuns.add({
        ...run('games/a', '2026-10-01T00:00:00.000Z'),
        report,
      })
      expect((await store.auditRuns.get(stored.id))?.report).toEqual(report)
    })

    test('analyses: add, get, list newest first by repo, kind and time', async () => {
      const first = await store.analyses.add(
        record('bundle', 'games/a', '2026-10-01T00:00:00.000Z', 'v1.0.0'),
      )
      await store.analyses.add(record('bundle', 'games/a', '2026-10-03T00:00:00.000Z', 'v1.1.0'))
      await store.analyses.add(record('changelog', 'games/a', '2026-10-02T00:00:00.000Z'))
      await store.analyses.add(record('bundle', 'games/b', '2026-10-04T00:00:00.000Z'))

      expect(await store.analyses.get(first.id)).toEqual(first)
      expect(first.ref).toBe('v1.0.0')
      expect(await store.analyses.get('missing')).toBeUndefined()
      expect((await store.analyses.list()).map((r) => r.createdAt.slice(8, 10))).toEqual([
        '04',
        '03',
        '02',
        '01',
      ])
      const bundlesOfA = await store.analyses.list({
        repo: { forge: 'work', path: 'games/a' },
        kind: 'bundle',
      })
      expect(bundlesOfA.map((r) => r.ref)).toEqual(['v1.1.0', 'v1.0.0'])
      const previous = await store.analyses.list({
        repo: { forge: 'work', path: 'games/a' },
        kind: 'bundle',
        before: '2026-10-03T00:00:00.000Z',
        limit: 1,
      })
      expect(previous.map((r) => r.ref)).toEqual(['v1.0.0'])
      expect(previous[0]?.data).toEqual({ kind: 'bundle', nested: { list: [1, 2] } })
    })

    test('credentials: put replaces, remove deletes', async () => {
      const credential: StoredCredential = {
        id: 'c1',
        name: 'GitLab bot',
        kind: 'gitlab',
        url: 'https://gitlab.test',
        scope: { groups: ['games'] },
        secret: 'v1.sealed',
        expiresAt: '2026-12-01T00:00:00.000Z',
        rotation: { enabled: true, daysBefore: 7, lifetimeDays: 30 },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }
      await store.credentials.put(credential)
      await store.credentials.put({ ...credential, name: 'Renamed' })
      expect(await store.credentials.list()).toEqual([{ ...credential, name: 'Renamed' }])
      await store.credentials.remove('c1')
      expect(await store.credentials.get('c1')).toBeUndefined()
    })

    test('credentials: options round-trip and can be cleared', async () => {
      const credential: StoredCredential = {
        id: 'c2',
        name: 'AI proxy',
        kind: 'ai',
        url: 'https://llm.example.test',
        scope: { all: true },
        secret: 'v1.sealed',
        options: {
          provider: 'anthropic-compatible',
          headers: { 'X-Team': 'platform' },
          modelMap: { 'claude-opus-5-5': 'opus' },
        },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }
      await store.credentials.put(credential)
      expect(await store.credentials.get('c2')).toEqual(credential)
      const { options: _, ...withoutOptions } = credential
      await store.credentials.put(withoutOptions)
      expect(await store.credentials.get('c2')).toEqual(withoutOptions)
    })

    test('settings: list by key', async () => {
      const base = { scope: { all: true }, secret: false, updatedAt: '2026-10-01T00:00:00.000Z' }
      await store.settings.put({ ...base, id: 's1', key: 'llm.model', value: 'claude-opus-5-5' })
      await store.settings.put({ ...base, id: 's2', key: 'audit.fix', value: { enabled: true } })
      expect((await store.settings.list('llm.model')).map((s) => s.value)).toEqual([
        'claude-opus-5-5',
      ])
      expect(await store.settings.list()).toHaveLength(2)
      await store.settings.remove('s1')
      expect(await store.settings.get('s1')).toBeUndefined()
    })

    test('users: users, passkeys, identities and link tokens', async () => {
      await store.users.putUser(user('u1', { email: 'Jane@Example.com' }))
      await store.users.putUser(user('u2'))
      expect((await store.users.findUserByEmail('jane@example.com'))?.id).toBe('u1')
      expect((await store.users.listUsers()).map((u) => u.id).toSorted()).toEqual(['u1', 'u2'])

      const passkey = {
        id: 'pk1',
        userId: 'u1',
        publicKey: 'pub',
        counter: 0,
        transports: ['internal'],
        createdAt: 'now',
      }
      await store.users.putPasskey(passkey)
      await store.users.putPasskey({ ...passkey, counter: 5 })
      expect((await store.users.getPasskey('pk1'))?.counter).toBe(5)
      expect(await store.users.listPasskeys('u1')).toHaveLength(1)

      await store.users.putIdentity({ provider: 'google', subject: 'abc', userId: 'u1' })
      expect((await store.users.findIdentity('google', 'abc'))?.userId).toBe('u1')
      expect(await store.users.findIdentity('google', 'other')).toBeUndefined()
      expect((await store.users.listIdentities('u1')).map((i) => i.subject)).toEqual(['abc'])
      expect(await store.users.listIdentities('u2')).toEqual([])

      await store.users.putLinkToken({
        tokenHash: 'h',
        userId: 'u1',
        purpose: 'enroll',
        expiresAt: 'later',
      })
      await store.users.putLinkToken({
        tokenHash: 'h',
        userId: 'u1',
        purpose: 'enroll',
        expiresAt: 'later',
        usedAt: 'now',
      })
      expect((await store.users.getLinkToken('h'))?.usedAt).toBe('now')

      await store.users.removeUser('u1')
      expect(await store.users.getUser('u1')).toBeUndefined()
      expect(await store.users.listPasskeys('u1')).toEqual([])
      expect(await store.users.findIdentity('google', 'abc')).toBeUndefined()
      expect(await store.users.getLinkToken('h')).toBeUndefined()
    })

    test('activity: append and list newest first', async () => {
      await store.activity.append({
        at: '2026-10-01T00:00:00.000Z',
        actor: 'root',
        action: 'a.one',
      })
      await store.activity.append({
        at: '2026-10-02T00:00:00.000Z',
        actor: 'root',
        action: 'a.two',
        subject: 'x',
        details: { n: 1 },
      })
      const events = await store.activity.list()
      expect(events.map((e) => e.action)).toEqual(['a.two', 'a.one'])
      expect(events[0]?.details).toEqual({ n: 1 })
      expect(await store.activity.list({ before: '2026-10-02T00:00:00.000Z' })).toHaveLength(1)
    })
    test('jobs: enqueue applies defaults and round-trips fields', async () => {
      const queued = await store.jobs.enqueue(
        job('games/a', t(0), {
          ref: 'v1.0.0',
          options: { budget: { js: 100 } },
          actor: 'jane',
          group: 'games',
          maxAttempts: 5,
        }),
      )
      expect(queued).toMatchObject({
        analyzer: 'bundle',
        repo: { forge: 'work', path: 'games/a' },
        group: 'games',
        ref: 'v1.0.0',
        options: { budget: { js: 100 } },
        trigger: 'manual',
        status: 'queued',
        attempts: 0,
        maxAttempts: 5,
        runAfter: t(0),
        createdAt: t(0),
        log: [],
        actor: 'jane',
      })
      expect(await store.jobs.get(queued.id)).toEqual(queued)
      expect(await store.jobs.get('missing')).toBeUndefined()
      const plain = await store.jobs.enqueue(job('games/b', t(1)))
      expect(plain.maxAttempts).toBe(3)
      expect(plain.options).toEqual({})
      expect(plain.ref).toBeUndefined()
    })

    test('jobs: claim takes the oldest due job and skips busy repositories', async () => {
      const late = await store.jobs.enqueue(job('games/a', t(0), { runAfter: t(30) }))
      const a1 = await store.jobs.enqueue(job('games/a', t(1)))
      const a2 = await store.jobs.enqueue(job('games/a', t(2)))
      const b = await store.jobs.enqueue(job('games/b', t(3)))

      const first = await store.jobs.claim('w1', t(10))
      expect(first).toMatchObject({
        id: a1.id,
        status: 'running',
        attempts: 1,
        workerId: 'w1',
        startedAt: t(10),
        heartbeatAt: t(10),
      })
      expect((await store.jobs.claim('w2', t(10)))?.id).toBe(b.id)
      expect(await store.jobs.claim('w2', t(10))).toBeUndefined()

      await store.jobs.complete(a1.id, { at: t(11), analysisId: 'an1' })
      expect((await store.jobs.claim('w2', t(11)))?.id).toBe(a2.id)
      await store.jobs.complete(a2.id, { at: t(12) })
      expect(await store.jobs.claim('w2', t(12))).toBeUndefined()
      expect((await store.jobs.claim('w2', t(30)))?.id).toBe(late.id)

      expect(await store.jobs.get(a1.id)).toMatchObject({
        status: 'succeeded',
        finishedAt: t(11),
        analysisId: 'an1',
      })
    })

    test('jobs: concurrent claims never hand out a job twice', async () => {
      for (let i = 0; i < 5; i++) await store.jobs.enqueue(job(`games/${i}`, t(i)))
      const claimed = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.jobs.claim(`w${i}`, t(10))),
      )
      const ids = claimed.flatMap((c) => (c ? [c.id] : []))
      expect(ids).toHaveLength(5)
      expect(new Set(ids).size).toBe(5)
    })

    test('jobs: heartbeat, fail with retry, fail for good', async () => {
      const queued = await store.jobs.enqueue(job('games/a', t(0), { maxAttempts: 2 }))
      await store.jobs.claim('w1', t(1))
      expect(await store.jobs.heartbeat(queued.id, 'w1', t(2))).toBeTrue()
      expect(await store.jobs.heartbeat(queued.id, 'w2', t(2))).toBeFalse()
      expect((await store.jobs.get(queued.id))?.heartbeatAt).toBe(t(2))

      const retried = await store.jobs.fail(queued.id, { at: t(3), error: 'boom', retryAt: t(5) })
      expect(retried).toMatchObject({ status: 'queued', runAfter: t(5), error: 'boom' })
      expect(retried?.workerId).toBeUndefined()
      expect(await store.jobs.claim('w1', t(4))).toBeUndefined()
      expect((await store.jobs.claim('w1', t(5)))?.attempts).toBe(2)

      const failed = await store.jobs.fail(queued.id, { at: t(6), error: 'again', retryAt: t(9) })
      expect(failed).toMatchObject({ status: 'failed', finishedAt: t(6), error: 'again' })
      expect(await store.jobs.fail(queued.id, { at: t(7), error: 'x' })).toBeUndefined()
      expect(await store.jobs.complete(queued.id, { at: t(7) })).toBeUndefined()
      expect(await store.jobs.heartbeat(queued.id, 'w1', t(7))).toBeFalse()
    })

    test('jobs: cancel queued and running jobs, keep finished ones', async () => {
      const queued = await store.jobs.enqueue(job('games/a', t(0)))
      const running = await store.jobs.enqueue(job('games/b', t(1)))
      await store.jobs.claim('w1', t(2))
      await store.jobs.claim('w1', t(2))

      expect(await store.jobs.cancel(queued.id, t(3))).toMatchObject({
        status: 'canceled',
        finishedAt: t(3),
      })
      expect((await store.jobs.cancel(running.id, t(3)))?.status).toBe('canceled')
      expect(await store.jobs.heartbeat(running.id, 'w1', t(4))).toBeFalse()
      expect(await store.jobs.complete(running.id, { at: t(4) })).toBeUndefined()
      expect((await store.jobs.cancel(running.id, t(5)))?.finishedAt).toBe(t(3))
      expect(await store.jobs.cancel('missing', t(5))).toBeUndefined()
    })

    test('jobs: recoverStale requeues or fails jobs of dead workers', async () => {
      const fresh = await store.jobs.enqueue(job('games/a', t(0)))
      const stale = await store.jobs.enqueue(job('games/b', t(0)))
      const spent = await store.jobs.enqueue(job('games/c', t(0), { maxAttempts: 1 }))
      await store.jobs.claim('w1', t(1))
      await store.jobs.claim('w1', t(1))
      await store.jobs.claim('w1', t(1))
      await store.jobs.heartbeat(fresh.id, 'w1', t(9))

      const changed = await store.jobs.recoverStale(t(5), t(10))
      expect(changed.map((j) => j.id).toSorted()).toEqual([stale.id, spent.id].toSorted())
      expect(await store.jobs.get(fresh.id)).toMatchObject({ status: 'running' })
      expect(await store.jobs.get(stale.id)).toMatchObject({ status: 'queued', runAfter: t(10) })
      expect(await store.jobs.get(spent.id)).toMatchObject({ status: 'failed', finishedAt: t(10) })
    })

    test('jobs: list newest first with filters, appendLog keeps the tail', async () => {
      const a = await store.jobs.enqueue(job('games/a', t(1)))
      await store.jobs.enqueue(job('games/b', t(2), { analyzer: 'changelog' }))
      const c = await store.jobs.enqueue(job('games/a', t(3)))
      await store.jobs.claim('w1', t(4))

      expect((await store.jobs.list()).map((j) => j.createdAt)).toEqual([t(3), t(2), t(1)])
      expect((await store.jobs.list({ status: 'running' })).map((j) => j.id)).toEqual([a.id])
      expect(await store.jobs.list({ status: ['queued', 'running'] })).toHaveLength(3)
      expect(
        (await store.jobs.list({ repo: { forge: 'work', path: 'games/a' } })).map((j) => j.id),
      ).toEqual([c.id, a.id])
      expect(await store.jobs.list({ analyzer: 'changelog' })).toHaveLength(1)
      expect((await store.jobs.list({ before: t(3), limit: 1 })).map((j) => j.createdAt)).toEqual([
        t(2),
      ])

      await store.jobs.appendLog(a.id, ['one', 'two'])
      await store.jobs.appendLog(
        a.id,
        Array.from({ length: 200 }, (_, i) => `line ${i}`),
      )
      const log = (await store.jobs.get(a.id))?.log ?? []
      expect(log).toHaveLength(200)
      expect(log[0]).toBe('line 0')
      expect(log.at(-1)).toBe('line 199')
      await store.jobs.appendLog('missing', ['x'])
    })
    test('knowledge: put bumps the version and keeps history, remove drops both', async () => {
      const first = await store.knowledge.put(knowledgeEntry('k1', { updatedAt: t(0) }))
      expect(first.version).toBe(1)
      expect(await store.knowledge.history('k1')).toEqual([])

      const second = await store.knowledge.put(
        knowledgeEntry('k1', { title: 'Use Vitest', updatedAt: t(1), updatedBy: 'jane' }),
      )
      expect(second).toMatchObject({ version: 2, title: 'Use Vitest', updatedBy: 'jane' })
      await store.knowledge.put(
        knowledgeEntry('k1', { status: 'archived', updatedAt: t(2), updatedBy: 'bob' }),
      )
      expect(await store.knowledge.get('k1')).toMatchObject({ version: 3, status: 'archived' })
      const history = await store.knowledge.history('k1')
      expect(history.map((r) => [r.version, r.editedBy, r.editedAt, r.title])).toEqual([
        [2, 'jane', t(1), 'Use Vitest'],
        [1, 'agent:review', t(0), 'Prefer Vitest over Jest'],
      ])
      expect(history[1]).toMatchObject({
        scope: { groups: ['games'] },
        packages: [{ ecosystem: 'npm', name: 'vitest', from: '>=1 <2' }],
        evidence: [{ label: 'MR', url: 'https://forge.test/mr/1' }],
      })

      await store.knowledge.remove('k1')
      expect(await store.knowledge.get('k1')).toBeUndefined()
      expect(await store.knowledge.history('k1')).toEqual([])
      expect(await store.knowledge.history('missing')).toEqual([])
    })

    test('knowledge: entries round-trip, optional fields stay absent', async () => {
      const plain = knowledgeEntry('k2', { updatedAt: t(0) })
      delete plain.packages
      delete plain.updatedBy
      const stored = await store.knowledge.put(plain)
      expect(stored).toEqual({ ...plain, version: 1 })
      expect(await store.knowledge.get('k2')).toEqual({ ...plain, version: 1 })
      const full = await store.knowledge.put(
        knowledgeEntry('k3', { supersedes: 'k2', updatedAt: t(1) }),
      )
      expect(await store.knowledge.get('k3')).toEqual(full)
    })

    test('knowledge: list newest first with filters', async () => {
      await store.knowledge.put(knowledgeEntry('a', { updatedAt: t(1) }))
      await store.knowledge.put(
        knowledgeEntry('b', {
          kind: 'migration',
          status: 'proposed',
          topics: ['I18n'],
          scope: { repos: ['work:tools/**'] },
          packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19' }],
          updatedAt: t(3),
        }),
      )
      await store.knowledge.put(
        knowledgeEntry('c', {
          status: 'rejected',
          scope: { all: true },
          packages: [{ ecosystem: 'go', name: 'react' }],
          updatedAt: t(2),
        }),
      )
      const ids = async (filter: KnowledgeFilter) =>
        (await store.knowledge.list(filter)).map((entry) => entry.id)

      expect(await ids({})).toEqual(['b', 'c', 'a'])
      expect(await ids({ status: 'accepted' })).toEqual(['a'])
      expect(await ids({ status: ['accepted', 'proposed'] })).toEqual(['b', 'a'])
      expect(await ids({ kind: 'migration' })).toEqual(['b'])
      expect(await ids({ kind: ['convention', 'migration'] })).toEqual(['b', 'c', 'a'])
      expect(await ids({ topic: 'i18n' })).toEqual(['b'])
      expect(await ids({ scope: 'TOOLS' })).toEqual(['b'])
      expect(await ids({ scope: 'games' })).toEqual(['a'])
      expect(await ids({ scope: 'all' })).toEqual(['c'])
      expect(await ids({ package: 'react' })).toEqual(['b', 'c'])
      expect(await ids({ package: 'npm:react' })).toEqual(['b'])
      expect(await ids({ package: 'vue' })).toEqual([])
      expect(await ids({ status: 'proposed', topic: 'testing' })).toEqual([])
    })

    test('knowledge: search ranks title over topics over body, matches prefixes', async () => {
      await store.knowledge.put(
        knowledgeEntry('body', {
          title: 'Release notes',
          body: 'Mention snapshot tests.',
          topics: [],
        }),
      )
      await store.knowledge.put(
        knowledgeEntry('title', {
          title: 'Snapshot tests are banned',
          body: 'See review.',
          topics: [],
        }),
      )
      await store.knowledge.put(
        knowledgeEntry('topic', {
          title: 'Fixtures',
          body: 'Keep them small.',
          topics: ['snapshots'],
        }),
      )
      await store.knowledge.put(
        knowledgeEntry('other', { title: 'Translations', body: 'Use ICU.', topics: ['i18n'] }),
      )

      const hits = await store.knowledge.search('snapshot')
      expect(hits.map((hit) => hit.entry.id)).toEqual(['title', 'topic', 'body'])
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
      expect(hits[0]?.entry.version).toBe(1)
      expect((await store.knowledge.search('transl')).map((hit) => hit.entry.id)).toEqual(['other'])
      expect((await store.knowledge.search('ICU snapshot', {}, 2)).length).toBe(2)
      expect(
        (await store.knowledge.search('snapshot', { topic: 'snapshots' })).map((h) => h.entry.id),
      ).toEqual(['topic'])
      expect(await store.knowledge.search('   ')).toEqual([])
      expect(await store.knowledge.search('nothing-like-this')).toEqual([])
    })

    test('knowledge: search treats operators and punctuation as plain words', async () => {
      await store.knowledge.put(
        knowledgeEntry('ops', {
          title: 'NOT a drill',
          body: 'Use "quotes" AND (parens) near: x*y-z',
        }),
      )
      for (const query of [
        '"',
        '"quotes',
        'AND',
        'NOT',
        'OR OR',
        'near(',
        'NEAR(x y)',
        'title:drill',
        '*',
        'x*',
        '-z',
        '^drill',
        "it's",
        '(((',
        '{x}',
      ]) {
        const hits = await store.knowledge.search(query)
        expect(Array.isArray(hits)).toBeTrue()
      }
      expect((await store.knowledge.search('"quotes"')).map((h) => h.entry.id)).toEqual(['ops'])
      expect((await store.knowledge.search('title:drill')).map((h) => h.entry.id)).toEqual(['ops'])
      expect((await store.knowledge.search('NOT')).map((h) => h.entry.id)).toEqual(['ops'])
    })

    test('ci jobs: put replaces by job id, list oldest first in a range, coverage, prune', async () => {
      const a = { forge: 'work', path: 'games/a' }
      await store.ciJobs.put([
        ciJob('games/a', 2, '2026-10-02T00:00:00Z', {
          status: 'failed',
          ref: 'main',
          sha: 'abc',
          startedAt: '2026-10-02T00:01:00+00:00',
          finishedAt: '2026-10-02T00:05:00.000Z',
          durationSeconds: 240.5,
          queuedSeconds: 60,
          allowFailure: true,
        }),
        ciJob('games/a', 1, '2026-10-01T00:00:00.000Z'),
        ciJob('games/a', 3, '2026-10-03T00:00:00.000Z'),
        ciJob('games/b', 1, '2026-09-01T00:00:00.000Z'),
      ])
      await store.ciJobs.put([
        ciJob('games/a', 3, '2026-10-03T00:00:00.000Z', { status: 'canceled' }),
      ])

      const all = await store.ciJobs.list(a)
      expect(all.map((r) => [r.jobId, r.status])).toEqual([
        [1, 'success'],
        [2, 'failed'],
        [3, 'canceled'],
      ])
      expect(all[1]).toEqual(
        ciJob('games/a', 2, '2026-10-02T00:00:00.000Z', {
          status: 'failed',
          ref: 'main',
          sha: 'abc',
          startedAt: '2026-10-02T00:01:00.000Z',
          finishedAt: '2026-10-02T00:05:00.000Z',
          durationSeconds: 240.5,
          queuedSeconds: 60,
          allowFailure: true,
        }),
      )
      const ranged = await store.ciJobs.list(a, {
        from: '2026-10-02T00:00:00.000Z',
        to: '2026-10-03T00:00:00.000Z',
      })
      expect(ranged.map((r) => r.jobId)).toEqual([2])
      expect(await store.ciJobs.coverage(a)).toEqual({
        oldest: '2026-10-01T00:00:00.000Z',
        newest: '2026-10-03T00:00:00.000Z',
        jobs: 3,
      })
      expect(await store.ciJobs.coverage({ forge: 'work', path: 'none' })).toBeUndefined()

      expect(await store.ciJobs.prune('2026-10-02T00:00:00.000Z')).toBe(2)
      expect((await store.ciJobs.list(a)).map((r) => r.jobId)).toEqual([2, 3])
      expect(await store.ciJobs.list({ forge: 'work', path: 'games/b' })).toEqual([])
    })

    test('ai usage: append, list newest first with filters, paging and scopes', async () => {
      const first = await store.aiUsage.append(usage({ at: '2026-10-01T10:00:00.000Z' }))
      await store.aiUsage.append(
        usage({ at: '2026-10-02T10:00:00.000Z', model: 'claude-sonnet-5-5', analyzer: 'review' }),
      )
      await store.aiUsage.append(
        usage({
          at: '2026-10-03T10:00:00.000Z',
          repo: { forge: 'work', path: 'tools/cli' },
          groups: ['tools'],
          outcome: 'error',
          error: 'boom',
        }),
      )

      expect(first.id).toBeString()
      expect(first).toMatchObject({ costSource: 'reported', groups: ['games'] })
      expect(first.analyzer).toBeUndefined()
      const all = await store.aiUsage.list()
      expect(all.map((r) => r.at.slice(8, 10))).toEqual(['03', '02', '01'])
      expect(all[0]).toMatchObject({ outcome: 'error', error: 'boom' })
      expect(
        (await store.aiUsage.list({ before: '2026-10-03T00:00:00.000Z', limit: 1 })).map((r) =>
          r.at.slice(8, 10),
        ),
      ).toEqual(['02'])
      expect((await store.aiUsage.list({ model: 'claude-sonnet-5-5' })).length).toBe(1)
      expect((await store.aiUsage.list({ analyzer: 'review' })).length).toBe(1)
      expect((await store.aiUsage.list({ group: 'tools' })).length).toBe(1)
      expect(
        (await store.aiUsage.list({ repo: { forge: 'work', path: 'games/slots' } })).length,
      ).toBe(2)
      expect(
        (
          await store.aiUsage.list({
            from: '2026-10-02T00:00:00.000Z',
            to: '2026-10-03T10:00:00.000Z',
          })
        ).length,
      ).toBe(1)
      expect((await store.aiUsage.list({ scopes: [] })).length).toBe(0)
      expect((await store.aiUsage.list({ scopes: [{ groups: ['tools'] }] })).length).toBe(1)
      expect((await store.aiUsage.list({ scopes: [{ repos: ['work:games/**'] }] })).length).toBe(2)
      expect(
        (await store.aiUsage.list({ scopes: [{ repos: ['other:games/**'] }, { all: true }] }))
          .length,
      ).toBe(3)
    })

    test('ai usage: aggregate sums per bucket, sorted by key', async () => {
      await store.aiUsage.append(usage({ at: '2026-10-05T10:00:00.000Z', durationMs: 100 }))
      await store.aiUsage.append(
        usage({ at: '2026-10-05T23:59:59.999Z', durationMs: 300, outcome: 'error' }),
      )
      await store.aiUsage.append(
        usage({
          at: '2026-10-11T08:00:00.000Z',
          model: 'claude-sonnet-5-5',
          groups: ['games', 'slots'],
          costUsd: 0.25,
        }),
      )
      await store.aiUsage.append(
        usage({
          at: '2026-11-02T08:00:00.000Z',
          repo: { forge: 'work', path: 'misc/x' },
          groups: [],
          outcome: 'denied-budget',
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        }),
      )

      const [total, ...rest] = await store.aiUsage.aggregate()
      expect(rest).toEqual([])
      expect(total).toMatchObject({
        key: {},
        inputTokens: 300,
        outputTokens: 60,
        cacheReadTokens: 600,
        cacheWriteTokens: 30,
        runs: 4,
        errors: 1,
        denied: 1,
      })
      expect(total?.costUsd).toBeCloseTo(0.45)
      expect(total?.avgDurationMs).toBeCloseTo(1400 / 3)

      const byDay = await store.aiUsage.aggregate({ groupBy: ['day'] })
      expect(byDay.map((b) => [b.key.day, b.runs])).toEqual([
        ['2026-10-05', 2],
        ['2026-10-11', 1],
        ['2026-11-02', 1],
      ])
      const byWeek = await store.aiUsage.aggregate({ groupBy: ['week'] })
      expect(byWeek.map((b) => [b.key.week, b.runs])).toEqual([
        ['2026-10-05', 3],
        ['2026-11-02', 1],
      ])
      const byMonthModel = await store.aiUsage.aggregate({ groupBy: ['month', 'model'] })
      expect(byMonthModel.map((b) => [b.key.month, b.key.model, b.runs])).toEqual([
        ['2026-10', 'claude-opus-5-5', 2],
        ['2026-10', 'claude-sonnet-5-5', 1],
        ['2026-11', 'claude-opus-5-5', 1],
      ])
      const byGroup = await store.aiUsage.aggregate({ groupBy: ['group'] })
      expect(byGroup.map((b) => [b.key.group, b.runs])).toEqual([
        ['', 1],
        ['games', 3],
        ['slots', 1],
      ])
      const byRepo = await store.aiUsage.aggregate({
        groupBy: ['repo', 'analyzer', 'taskKind', 'provider'],
      })
      expect(byRepo.map((b) => b.key)).toEqual([
        { repo: 'work:games/slots', analyzer: '', taskKind: 'review', provider: 'anthropic' },
        { repo: 'work:misc/x', analyzer: '', taskKind: 'review', provider: 'anthropic' },
      ])

      const october = await store.aiUsage.aggregate({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
        filter: { from: '2026-10-05T12:00:00.000Z', outcome: 'ok' },
      })
      expect(october.map((b) => b.runs)).toEqual([1])
      expect(october[0]?.costUsd).toBeCloseTo(0.25)
      expect(await store.aiUsage.aggregate({ filter: { model: 'nothing' } })).toEqual([])
      expect(
        (await store.aiUsage.aggregate({ filter: { scopes: [{ groups: ['slots'] }] } }))[0]?.runs,
      ).toBe(1)
    })

    test('config documents: put bumps versions and keeps history, list orders, remove clears', async () => {
      const config = store.config
      if (!config) return
      const forge = await config.put({
        type: 'forge',
        id: 'work',
        data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: 'c1' },
        updatedAt: t(1),
        updatedBy: 'alice',
      })
      expect(forge.version).toBe(1)
      const changed = await config.put({
        type: 'forge',
        id: 'work',
        data: {
          kind: 'gitlab',
          url: 'https://gitlab.test',
          credentialId: 'c2',
          webhook: {
            secret: 'sealed',
            createdAt: t(2),
            registered: [{ hookId: '7', scope: 'group', target: 'games', url: 'https://h/x' }],
          },
        },
        updatedAt: t(2),
      })
      expect(changed.version).toBe(2)
      expect(changed.updatedBy).toBeUndefined()
      await config.put({
        type: 'group',
        id: 'games',
        data: { forge: 'work', include: ['games/*'], exclude: [] },
        updatedAt: t(3),
      })
      await config.put({
        type: 'trigger',
        id: 'label:port',
        data: { on: 'label', label: 'port', analyzers: ['port'] },
        updatedAt: t(3),
      })
      await config.put({
        type: 'group',
        id: 'apps',
        data: { forge: 'work', include: ['apps/*'], exclude: ['apps/old'] },
        updatedAt: t(4),
      })

      expect(await config.get('forge', 'work')).toEqual(changed)
      expect(await config.get('forge', 'missing')).toBeUndefined()
      expect(await config.get('group', 'work')).toBeUndefined()
      expect((await config.list('group')).map((d) => d.id)).toEqual(['apps', 'games'])
      expect((await config.list()).map((d) => `${d.type}:${d.id}`)).toEqual([
        'forge:work',
        'group:apps',
        'group:games',
        'trigger:label:port',
      ])
      expect(await config.history('forge', 'work')).toEqual([
        {
          version: 1,
          data: { kind: 'gitlab', url: 'https://gitlab.test', credentialId: 'c1' },
          updatedAt: t(1),
          updatedBy: 'alice',
        },
      ])
      expect(await config.history('group', 'nope')).toEqual([])

      await config.remove('forge', 'work')
      expect(await config.get('forge', 'work')).toBeUndefined()
      expect(await config.history('forge', 'work')).toEqual([])
      const again = await config.put({ ...changed, updatedAt: t(5) })
      expect(again.version).toBe(1)
    })

    test('kv: set, get, overwrite, delete and expiry sweep', async () => {
      const kv = store.kv
      if (!kv) return
      expect(await kv.get('missing')).toBeUndefined()
      await kv.set('a', { done: true })
      await kv.set('b', 1, 60)
      await kv.set('c', 'x', 3600)
      expect(await kv.get('a')).toEqual({ done: true })
      await kv.set('a', [1, 2])
      expect(await kv.get('a')).toEqual([1, 2])
      expect(await kv.get('b')).toBe(1)
      expect(await kv.sweep(new Date(Date.now() + 120_000))).toBe(1)
      expect(await kv.get('b')).toBeUndefined()
      expect(await kv.get('c')).toBe('x')
      await kv.delete('c')
      expect(await kv.get('c')).toBeUndefined()
      expect(await kv.get('a')).toEqual([1, 2])
      expect(kv.set('d', 1, 0)).rejects.toThrow()
    })

    test('kv: leases go to one holder until they expire or are released', async () => {
      const kv = store.kv
      if (!kv?.acquireLease || !kv.releaseLease) return
      expect(await kv.acquireLease('lease', 'a', 30, leaseAt(0))).toEqual({
        holder: 'a',
        expiresAt: leaseAt(30).toISOString(),
      })
      expect((await kv.acquireLease('lease', 'b', 30, leaseAt(10))).holder).toBe('a')
      expect((await kv.acquireLease('lease', 'a', 30, leaseAt(20))).expiresAt).toBe(
        leaseAt(50).toISOString(),
      )
      expect((await kv.acquireLease('lease', 'b', 30, leaseAt(49))).holder).toBe('a')
      expect((await kv.acquireLease('lease', 'b', 30, leaseAt(50))).holder).toBe('b')
      expect(await kv.releaseLease('lease', 'a')).toBe(false)
      expect(await kv.releaseLease('lease', 'b')).toBe(true)
      expect((await kv.acquireLease('lease', 'a', 30, leaseAt(51))).holder).toBe('a')
      expect(
        await kv.acquireLease('lease', 'a', 0).catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
    })

    test('kv: compareAndSet writes only over the expected value', async () => {
      const kv = store.kv
      if (!kv?.compareAndSet) return
      expect(await kv.compareAndSet('cas', { n: 1 }, { n: 2 })).toBe(false)
      expect(await kv.compareAndSet('cas', undefined, { n: 1, m: [1] })).toBe(true)
      expect(await kv.compareAndSet('cas', undefined, { n: 9 })).toBe(false)
      expect(await kv.compareAndSet('cas', { m: [1], n: 1 }, { n: 2 }, 60)).toBe(true)
      expect(await kv.get('cas')).toEqual({ n: 2 })
      expect(await kv.compareAndSet('cas', { n: 1 }, { n: 3 })).toBe(false)
      expect(await kv.sweep(new Date(Date.now() + 120_000))).toBeGreaterThanOrEqual(1)
      expect(await kv.compareAndSet('cas', undefined, { n: 4 })).toBe(true)
    })

    test('audit: append builds a hash chain; list pages newest first with filters', async () => {
      const audit = store.audit
      if (!audit) return
      const first = await audit.append(auditInput(1))
      expect(first.seq).toBe(1)
      expect(first.prevHash).toBe(AUDIT_GENESIS_HASH)
      expect(first.hash).toBe(auditHash(first))
      const second = await audit.append(
        auditInput(2, {
          action: 'setting.update',
          target: { type: 'setting', id: 's1', repo: 'work:games/a' },
          outcome: 'denied',
          status: 403,
          via: 'api',
        }),
      )
      expect(second.seq).toBe(2)
      expect(second.prevHash).toBe(first.hash)
      await audit.append(
        auditInput(3, {
          actor: { id: 'bot', name: 'Bot', provider: 'webhook' },
          via: 'webhook',
          action: 'credential.rotate',
        }),
      )
      const { request: _request, changes: _changes, status: _status, ...bare } = auditInput(4)
      const fourth = await audit.append({ ...bare, details: { nested: { list: [1, 'x'] } } })
      expect(fourth.request).toBeUndefined()

      expect(await audit.get(first.id)).toEqual(first)
      expect(await audit.get('missing')).toBeUndefined()

      const page1 = await audit.list({ limit: 3 })
      expect(page1.events.map((e) => e.seq)).toEqual([4, 3, 2])
      expect(page1.nextCursor).toBeString()
      const page2 = await audit.list({ limit: 3, cursor: page1.nextCursor })
      expect(page2.events.map((e) => e.seq)).toEqual([1])
      expect(page2.nextCursor).toBeUndefined()
      expect((await audit.list({ limit: 4 })).nextCursor).toBeUndefined()

      const seqs = async (filter: Parameters<typeof audit.list>[0]) =>
        (await audit.list(filter)).events.map((e) => e.seq)
      expect(await seqs({ action: 'credential' })).toEqual([4, 3, 1])
      expect(await seqs({ action: 'credential.rot' })).toEqual([3])
      expect(await seqs({ actor: 'bot' })).toEqual([3])
      expect(await seqs({ outcome: 'denied' })).toEqual([2])
      expect(await seqs({ repo: 'work:games/a' })).toEqual([2])
      expect(await seqs({ targetType: 'setting', targetId: 's1' })).toEqual([2])
      expect(await seqs({ via: 'webhook' })).toEqual([3])
      expect(
        await seqs({ from: '2026-10-30T09:02:00.000Z', to: '2026-10-30T09:04:00.000Z' }),
      ).toEqual([3, 2])
      expect(await seqs({ action: '50%_' })).toEqual([])

      expect(await audit.count()).toBe(4)
      expect(await audit.count({ action: 'credential' })).toBe(3)
      const exported = []
      for await (const event of audit.export({ action: 'credential' })) exported.push(event.seq)
      expect(exported).toEqual([1, 3, 4])
      expect((await audit.get(fourth.id))?.details).toEqual({ nested: { list: [1, 'x'] } })
    })

    test('audit: verifyChain and retention sweep keep the chain whole', async () => {
      const audit = store.audit
      if (!audit) return
      expect(await audit.verifyChain()).toEqual({ ok: true, checked: 0 })
      for (const minute of [1, 2, 3, 5, 4, 6]) await audit.append(auditInput(minute))
      expect(await audit.verifyChain()).toEqual({ ok: true, checked: 6, firstSeq: 1, lastSeq: 6 })
      expect(await audit.verifyChain({ fromSeq: 2, toSeq: 4 })).toMatchObject({
        ok: true,
        checked: 3,
        firstSeq: 2,
        lastSeq: 4,
      })

      // The event at minute 4 has seq 5, after the one at minute 5: the sweep stops at the first
      // kept event so no hole opens in the chain.
      expect(await audit.sweep('2026-10-30T09:05:00.000Z')).toBe(3)
      expect((await audit.list()).events.map((e) => e.seq)).toEqual([6, 5, 4])
      expect(await audit.verifyChain()).toEqual({ ok: true, checked: 3, firstSeq: 4, lastSeq: 6 })
      expect(await audit.sweep('2026-10-30T09:05:00.000Z')).toBe(0)

      expect(await audit.sweep('2026-10-31T00:00:00.000Z')).toBe(3)
      expect(await audit.verifyChain()).toEqual({ ok: true, checked: 0 })
      const next = await audit.append(auditInput(7))
      expect(next.seq).toBe(7)
      expect(await audit.verifyChain()).toMatchObject({ ok: true, checked: 1, firstSeq: 7 })
    })

    test('external accounts: put, find, list, unique per provider and id, remove', async () => {
      const accounts = store.externalAccounts
      if (!accounts) return
      await store.users.putUser(user('u1'))
      await store.users.putUser(user('u2'))
      const a = externalAccount('a1', {
        username: 'alice',
        verification: 'unverified',
        challenge: { hash: 'h', expiresAt: '2026-10-30T10:00:00.000Z', attempts: 1 },
      })
      await accounts.put(a)
      await accounts.put(externalAccount('a2', { provider: 'slack:T1', externalId: 'U2' }))
      await accounts.put(externalAccount('a3', { userId: 'u2', externalId: '3' }))
      await accounts.put(
        externalAccount('a4', {
          userId: 'header-jane',
          externalId: '4',
          principal: { name: 'Jane', provider: 'header', grants: [] },
        }),
      )

      expect(await accounts.get('a1')).toEqual(a)
      expect(await accounts.get('missing')).toBeUndefined()
      expect(await accounts.find('gitlab:work', '1')).toEqual(a)
      expect(await accounts.find('gitlab:other', '1')).toBeUndefined()
      expect((await accounts.listByUser('u1')).map((x) => x.id)).toEqual(['a1', 'a2'])
      expect((await accounts.list('gitlab:work')).map((x) => x.id)).toEqual(['a1', 'a3', 'a4'])
      expect((await accounts.list()).map((x) => x.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
      expect((await accounts.get('a4'))?.principal).toEqual({
        name: 'Jane',
        provider: 'header',
        grants: [],
      })

      const verified: ExternalAccount = {
        ...a,
        verification: 'challenge',
        verifiedAt: '2026-10-30T09:30:00.000Z',
      }
      delete verified.challenge
      await accounts.put(verified)
      expect(await accounts.get('a1')).toEqual(verified)
      expect((await accounts.listByUser('u1')).map((x) => x.id)).toEqual(['a1', 'a2'])

      const conflict = await accounts.put(externalAccount('dupe', { externalId: '1' })).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(conflict).toBeInstanceOf(ExternalAccountConflictError)

      await accounts.remove('a2')
      expect(await accounts.get('a2')).toBeUndefined()
      await store.users.removeUser('u1')
      expect(await accounts.get('a1')).toBeUndefined()
      expect(await accounts.get('a3')).toBeDefined()
      await accounts.put(externalAccount('again', { userId: 'u2', externalId: '1' }))
      expect((await accounts.find('gitlab:work', '1'))?.id).toBe('again')
    })

    test('users: avatar seed round-trips', async () => {
      await store.users.putUser(user('u1', { avatarSeed: 'reroll-1' }))
      expect((await store.users.getUser('u1'))?.avatarSeed).toBe('reroll-1')
      await store.users.putUser(user('u1'))
      expect((await store.users.getUser('u1'))?.avatarSeed).toBeUndefined()
    })
  })
}
