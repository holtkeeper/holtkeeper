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
  LibraryChunk,
  LibraryChunkFilter,
  LibraryIssue,
  LibraryRecord,
  LibraryRef,
  LibraryVersionRecord,
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

const refs = (records: { ref?: string }[]) => records.map((r) => r.ref)

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
  repo: { forge: 'work', path: 'games/app' },
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

const reactLib: LibraryRef = { ecosystem: 'npm', name: 'react' }
const vueLib: LibraryRef = { ecosystem: 'npm', name: 'vue' }

const libraryRecord = (ref: LibraryRef, overrides: Partial<LibraryRecord> = {}): LibraryRecord => ({
  ...ref,
  sources: {},
  updatedAt: '2026-10-30T09:00:00.000Z',
  ...overrides,
})

const libraryVersion = (
  ref: LibraryRef,
  version: string,
  overrides: Partial<LibraryVersionRecord> = {},
): LibraryVersionRecord => ({
  ...ref,
  version,
  roles: ['used'],
  usedBy: [],
  sources: {},
  updatedAt: '2026-10-30T09:00:00.000Z',
  ...overrides,
})

const libraryChunk = (
  id: string,
  overrides: Partial<Omit<LibraryChunk, 'versions'>> = {},
): Omit<LibraryChunk, 'versions'> => ({
  ...reactLib,
  id,
  source: 'archive',
  path: 'README.md',
  headings: ['React'],
  text: `Section ${id}.`,
  ...overrides,
})

const libraryIssue = (number: number, overrides: Partial<LibraryIssue> = {}): LibraryIssue => ({
  ...reactLib,
  id: `github.com/facebook/react#${number}`,
  number,
  kind: 'issue',
  title: `Issue ${number}`,
  state: 'closed',
  labels: [],
  url: `https://github.com/facebook/react/issues/${number}`,
  body: 'Nothing here.',
  pulls: [],
  reactions: 0,
  comments: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
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

    test('analyses: latest keeps the newest record per repository and kind', async () => {
      await store.analyses.add(record('bundle', 'games/a', '2026-10-01T00:00:00.000Z', 'v1.0.0'))
      await store.analyses.add(record('bundle', 'games/a', '2026-10-03T00:00:00.000Z', 'v1.1.0'))
      await store.analyses.add(record('changelog', 'games/a', '2026-10-02T00:00:00.000Z', 'c1'))
      await store.analyses.add(record('bundle', 'games/b', '2026-10-04T00:00:00.000Z', 'b1'))
      await store.analyses.add(record('bundle', 'games/c', '2026-10-05T00:00:00.000Z', 'c-old'))
      await store.analyses.add(record('bundle', 'games/c', '2026-10-05T00:00:00.000Z', 'c-new'))

      expect(refs(await store.analyses.latest())).toEqual(['c-new', 'b1', 'v1.1.0', 'c1'])
      expect(refs(await store.analyses.latest({ kind: 'bundle' }))).toEqual([
        'c-new',
        'b1',
        'v1.1.0',
      ])
      const ofA = await store.analyses.latest({ repo: { forge: 'work', path: 'games/a' } })
      expect(refs(ofA)).toEqual(['v1.1.0', 'c1'])
      expect(ofA[0]?.data).toEqual({ kind: 'bundle', nested: { list: [1, 2] } })
      expect(
        await store.analyses.latest({ repo: { forge: 'work', path: 'games/a' }, kind: 'review' }),
      ).toEqual([])
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
          schedule: 'nightly',
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
        schedule: 'nightly',
      })
      expect(await store.jobs.get(queued.id)).toEqual(queued)
      expect(await store.jobs.get('missing')).toBeUndefined()
      const plain = await store.jobs.enqueue(job('games/b', t(1)))
      expect(plain.maxAttempts).toBe(3)
      expect(plain.options).toEqual({})
      expect(plain.ref).toBeUndefined()
      expect(plain.schedule).toBeUndefined()
    })

    test('jobs: claim takes the oldest due job and skips repositories running the same analyzer', async () => {
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

    test('jobs: read-only jobs of one repository run side by side', async () => {
      const bundle = await store.jobs.enqueue(job('games/a', t(1)))
      const changelog = await store.jobs.enqueue(job('games/a', t(2), { analyzer: 'changelog' }))
      const coverage = await store.jobs.enqueue(job('games/a', t(3), { analyzer: 'coverage' }))
      const rules = { exclusive: ['port'] }
      const ids = [
        (await store.jobs.claim('w1', t(10), rules))?.id,
        (await store.jobs.claim('w2', t(10), rules))?.id,
        (await store.jobs.claim('w3', t(10), rules))?.id,
      ]
      expect(ids).toEqual([bundle.id, changelog.id, coverage.id])
    })

    test('jobs: an exclusive job runs alone on its repository and is not overtaken', async () => {
      const bundle = await store.jobs.enqueue(job('games/a', t(1)))
      const port = await store.jobs.enqueue(job('games/a', t(2), { analyzer: 'port' }))
      const changelog = await store.jobs.enqueue(job('games/a', t(3), { analyzer: 'changelog' }))
      const other = await store.jobs.enqueue(job('games/b', t(4)))
      const rules = { exclusive: ['port'] }

      expect((await store.jobs.claim('w1', t(10), rules))?.id).toBe(bundle.id)
      expect((await store.jobs.claim('w1', t(10), rules))?.id).toBe(other.id)
      expect(await store.jobs.claim('w1', t(10), rules)).toBeUndefined()

      await store.jobs.complete(bundle.id, { at: t(11) })
      expect((await store.jobs.claim('w1', t(11), rules))?.id).toBe(port.id)
      expect(await store.jobs.claim('w1', t(11), rules)).toBeUndefined()

      await store.jobs.complete(port.id, { at: t(12) })
      expect((await store.jobs.claim('w1', t(12), rules))?.id).toBe(changelog.id)
    })

    test('jobs: a job waits for the jobs it comes after that are running or queued ahead', async () => {
      const changelog = await store.jobs.enqueue(job('games/a', t(1), { analyzer: 'changelog' }))
      const risk = await store.jobs.enqueue(job('games/a', t(2), { analyzer: 'release-risk' }))
      const bundle = await store.jobs.enqueue(job('games/a', t(3)))
      const alone = await store.jobs.enqueue(job('games/b', t(4), { analyzer: 'release-risk' }))
      await store.jobs.enqueue(job('games/c', t(5), { analyzer: 'changelog', runAfter: t(20) }))
      const early = await store.jobs.enqueue(job('games/c', t(6), { analyzer: 'release-risk' }))
      const rules = { after: { 'release-risk': ['changelog'] } }

      expect((await store.jobs.claim('w1', t(10), rules))?.id).toBe(changelog.id)
      expect((await store.jobs.claim('w1', t(10), rules))?.id).toBe(bundle.id)
      expect((await store.jobs.claim('w1', t(10), rules))?.id).toBe(alone.id)
      expect((await store.jobs.claim('w1', t(10), rules))?.id).toBe(early.id)
      expect(await store.jobs.claim('w1', t(10), rules)).toBeUndefined()

      await store.jobs.complete(changelog.id, { at: t(11) })
      expect((await store.jobs.claim('w1', t(11), rules))?.id).toBe(risk.id)
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
      await store.jobs.enqueue(job('games/b', t(2), { analyzer: 'changelog', schedule: 'weekly' }))
      const c = await store.jobs.enqueue(job('games/a', t(3)))
      await store.jobs.claim('w1', t(4))

      expect((await store.jobs.list()).map((j) => j.createdAt)).toEqual([t(3), t(2), t(1)])
      expect((await store.jobs.list({ status: 'running' })).map((j) => j.id)).toEqual([a.id])
      expect(await store.jobs.list({ status: ['queued', 'running'] })).toHaveLength(3)
      expect(
        (await store.jobs.list({ repo: { forge: 'work', path: 'games/a' } })).map((j) => j.id),
      ).toEqual([c.id, a.id])
      expect(await store.jobs.list({ analyzer: 'changelog' })).toHaveLength(1)
      expect((await store.jobs.list({ schedule: 'weekly' })).map((j) => j.createdAt)).toEqual([
        t(2),
      ])
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
          tag: true,
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
          tag: true,
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
        (await store.aiUsage.list({ repo: { forge: 'work', path: 'games/app' } })).length,
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
          groups: ['games', 'web'],
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
        ['web', 1],
      ])
      const byRepo = await store.aiUsage.aggregate({
        groupBy: ['repo', 'analyzer', 'taskKind', 'provider'],
      })
      expect(byRepo.map((b) => b.key)).toEqual([
        { repo: 'work:games/app', analyzer: '', taskKind: 'review', provider: 'anthropic' },
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
        (await store.aiUsage.aggregate({ filter: { scopes: [{ groups: ['web'] }] } }))[0]?.runs,
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

    test('libraries: put replaces, get, list by ecosystem then name with a query, remove', async () => {
      const libs = store.libraries
      if (!libs) return
      const react = libraryRecord(reactLib, {
        description: 'UI library',
        homepage: 'https://react.dev',
        repository: {
          host: 'github.com',
          path: 'facebook/react',
          directory: 'packages/react',
          url: 'https://github.com/facebook/react',
        },
        latest: '19.0.0',
        sources: {
          registry: { status: 'ok', at: '2026-10-30T09:00:00.000Z' },
          issues: { status: 'failed', at: '2026-10-30T09:01:00.000Z', message: 'rate limited' },
        },
        issuesCursor: 'cursor-1',
      })
      await libs.putLibrary(react)
      await libs.putLibrary(libraryRecord({ ecosystem: 'npm', name: '@tanstack/react-query' }))
      await libs.putLibrary(libraryRecord({ ecosystem: 'Go', name: 'github.com/spf13/cobra' }))
      await libs.putLibrary(libraryRecord(vueLib))

      expect(await libs.getLibrary(reactLib)).toEqual(react)
      expect(await libs.getLibrary({ ecosystem: 'Go', name: 'react' })).toBeUndefined()
      const names = async (filter?: Parameters<typeof libs.listLibraries>[0]) =>
        (await libs.listLibraries(filter)).map((lib) => `${lib.ecosystem}:${lib.name}`)
      expect(await names()).toEqual([
        'Go:github.com/spf13/cobra',
        'npm:@tanstack/react-query',
        'npm:react',
        'npm:vue',
      ])
      expect(await names({ ecosystem: 'npm' })).toEqual([
        'npm:@tanstack/react-query',
        'npm:react',
        'npm:vue',
      ])
      expect(await names({ query: 'REACT' })).toEqual(['npm:@tanstack/react-query', 'npm:react'])
      expect(await names({ ecosystem: 'Go', query: 'react' })).toEqual([])

      const replaced = libraryRecord(reactLib, { latest: '19.1.0' })
      await libs.putLibrary(replaced)
      expect(await libs.getLibrary(reactLib)).toEqual(replaced)

      await libs.removeLibrary(vueLib)
      expect(await libs.getLibrary(vueLib)).toBeUndefined()
      expect(await names()).toHaveLength(3)
    })

    test('libraries: versions round-trip and list highest semantic version first', async () => {
      const libs = store.libraries
      if (!libs) return
      const full = libraryVersion(reactLib, '1.10.0', {
        publishedAt: '2026-09-01T00:00:00.000Z',
        deprecated: 'use 2.x',
        roles: ['used', 'minor'],
        usedBy: ['work:games/app', 'work:games/web'],
        tag: 'v1.10.0',
        commit: 'abc123',
        api: 'artifact-api',
        sourceArchive: 'artifact-zip',
        sources: { archive: { status: 'ok', at: '2026-10-30T09:00:00.000Z' } },
        leftAt: '2026-10-29T00:00:00.000Z',
      })
      for (const version of ['1.9.0', '1.10.0-beta.2', '0.9.1', '2.0.0', '1.10.0-rc.1'])
        await libs.putVersion(libraryVersion(reactLib, version))
      await libs.putVersion(libraryVersion(reactLib, '1.10.0'))
      await libs.putVersion(full)
      await libs.putVersion(libraryVersion(reactLib, '1.10.0-beta.10'))
      const cobra: LibraryRef = { ecosystem: 'Go', name: 'github.com/spf13/cobra' }
      for (const version of ['v1.2.0', 'v0.0.0-20230101000000-abcdef012345', 'v2.1.0', 'v1.10.3'])
        await libs.putVersion(libraryVersion(cobra, version))

      expect(await libs.getVersion(reactLib, '1.10.0')).toEqual(full)
      expect(await libs.getVersion(reactLib, '3.0.0')).toBeUndefined()
      expect(await libs.getVersion(vueLib, '1.10.0')).toBeUndefined()
      expect((await libs.listVersions(reactLib)).map((v) => v.version)).toEqual([
        '2.0.0',
        '1.10.0',
        '1.10.0-rc.1',
        '1.10.0-beta.10',
        '1.10.0-beta.2',
        '1.9.0',
        '0.9.1',
      ])
      expect((await libs.listVersions(cobra)).map((v) => v.version)).toEqual([
        'v2.1.0',
        'v1.10.3',
        'v1.2.0',
        'v0.0.0-20230101000000-abcdef012345',
      ])
      expect(await libs.listVersions(vueLib)).toEqual([])

      await libs.removeVersion(reactLib, '1.10.0')
      expect(await libs.getVersion(reactLib, '1.10.0')).toBeUndefined()
      expect(await libs.listVersions(reactLib)).toHaveLength(6)
    })

    test('libraries: replaceChunks reuses chunks by id and keeps other sources', async () => {
      const libs = store.libraries
      if (!libs) return
      const a = libraryChunk('a', { headings: ['React', 'Install'], anchor: 'install' })
      const b = libraryChunk('b')
      const b2 = libraryChunk('b2')
      const c = libraryChunk('c', { path: 'docs/hooks.md', url: 'https://unpkg.test/hooks.md' })
      const r = libraryChunk('r', { source: 'repository', path: 'CHANGELOG.md' })
      const v = libraryChunk('v', { ...vueLib })
      await libs.putVersion(libraryVersion(reactLib, '1.9.0'))
      await libs.putVersion(libraryVersion(reactLib, '1.10.0'))
      await libs.replaceChunks(reactLib, '1.9.0', 'archive', [a, b, c])
      await libs.replaceChunks(reactLib, '1.10.0', 'archive', [a, b2, c])
      await libs.replaceChunks(reactLib, '1.10.0', 'repository', [r])
      await libs.replaceChunks(reactLib, '1.9.0', 'repository', [r])
      await libs.replaceChunks(vueLib, '1.9.0', 'archive', [v])

      const versions = async (filter = {}) =>
        Object.fromEntries(
          (await libs.listChunks({ name: 'react', ...filter })).map((chunk) => [
            chunk.id,
            chunk.versions,
          ]),
        )
      expect(await versions()).toEqual({
        a: ['1.10.0', '1.9.0'],
        b: ['1.9.0'],
        b2: ['1.10.0'],
        c: ['1.10.0', '1.9.0'],
        r: ['1.10.0', '1.9.0'],
      })
      expect((await libs.listChunks({ name: 'react', path: 'README.md' }))[0]).toEqual({
        ...a,
        versions: ['1.10.0', '1.9.0'],
      })
      expect((await libs.listChunks({ path: 'docs/hooks.md' }))[0]).toEqual({
        ...c,
        versions: ['1.10.0', '1.9.0'],
      })

      await libs.replaceChunks(reactLib, '1.10.0', 'archive', [a])
      expect(await versions()).toEqual({
        a: ['1.10.0', '1.9.0'],
        b: ['1.9.0'],
        c: ['1.9.0'],
        r: ['1.10.0', '1.9.0'],
      })

      await libs.removeVersion(reactLib, '1.9.0')
      expect(await versions()).toEqual({ a: ['1.10.0'], r: ['1.10.0'] })
      expect(await libs.getVersion(reactLib, '1.9.0')).toBeUndefined()
      expect((await libs.listChunks({ name: 'vue' })).map((chunk) => chunk.versions)).toEqual([
        ['1.9.0'],
      ])

      await libs.replaceChunks(reactLib, '1.10.0', 'archive', [])
      expect(await versions()).toEqual({ r: ['1.10.0'] })
    })

    test('libraries: listChunks filters, in path order then document order, with a limit', async () => {
      const libs = store.libraries
      if (!libs) return
      await libs.replaceChunks(reactLib, '1.0.0', 'archive', [
        libraryChunk('x1', { path: 'docs/b.md' }),
        libraryChunk('x2', { path: 'docs/a.md', headings: ['A', 'Second'] }),
        libraryChunk('x3', { path: 'docs/a.md', headings: ['A', 'First'] }),
      ])
      await libs.replaceChunks(reactLib, '2.0.0', 'archive', [
        libraryChunk('x1', { path: 'docs/b.md' }),
      ])
      await libs.replaceChunks(reactLib, '1.0.0', 'releases', [
        libraryChunk('rel', { source: 'releases', path: 'v1.0.0' }),
      ])
      const cobra: LibraryRef = { ecosystem: 'Go', name: 'github.com/spf13/cobra' }
      await libs.replaceChunks(cobra, 'v1.0.0', 'repository', [
        libraryChunk('go', { ...cobra, source: 'repository', path: 'README.md' }),
      ])

      const ids = async (filter: LibraryChunkFilter, limit?: number) =>
        (await libs.listChunks(filter, limit)).map((chunk) => chunk.id)
      expect(await ids({})).toEqual(['go', 'x2', 'x3', 'x1', 'rel'])
      expect(await ids({ ecosystem: 'npm' })).toEqual(['x2', 'x3', 'x1', 'rel'])
      expect(await ids({ name: 'react', path: 'docs/a.md' })).toEqual(['x2', 'x3'])
      expect(await ids({ version: '2.0.0' })).toEqual(['x1'])
      expect(await ids({ name: 'react', version: '1.0.0', source: 'archive' })).toEqual([
        'x2',
        'x3',
        'x1',
      ])
      expect(await ids({ source: 'releases' })).toEqual(['rel'])
      expect(await ids({ ecosystem: 'Go' })).toEqual(['go'])
      expect(await ids({ name: 'vue' })).toEqual([])
      expect(await ids({ ecosystem: 'npm' }, 2)).toEqual(['x2', 'x3'])
    })

    test('libraries: searchChunks weighs headings above text, filters, phrases and plain words', async () => {
      const libs = store.libraries
      if (!libs) return
      await libs.replaceChunks(reactLib, '1.0.0', 'archive', [
        libraryChunk('heading', {
          headings: ['React', 'useEffect cleanup'],
          text: 'Runs after the render is committed.',
        }),
        libraryChunk('text', {
          headings: ['React', 'Effects'],
          text: 'Call useEffect and return a function.',
        }),
        libraryChunk('phrase', {
          path: 'docs/errors.md',
          headings: ['Errors'],
          text: 'TypeError: Cannot read property map of undefined',
        }),
        libraryChunk('scattered', {
          path: 'docs/errors.md',
          headings: ['Errors'],
          text: 'A property you cannot read: map is undefined',
        }),
      ])
      await libs.replaceChunks(reactLib, '2.0.0', 'repository', [
        libraryChunk('repo', {
          source: 'repository',
          headings: ['Hooks'],
          text: 'useEffect moved.',
        }),
      ])
      await libs.replaceChunks(vueLib, '1.0.0', 'archive', [
        libraryChunk('vue', { ...vueLib, headings: ['Vue'], text: 'There is no useEffect here.' }),
      ])

      const ids = async (text: string, filter?: LibraryChunkFilter, limit?: number) =>
        (await libs.searchChunks(text, filter, limit)).map((hit) => hit.chunk.id)
      const hits = await libs.searchChunks('useeffect', { name: 'react', version: '1.0.0' })
      expect(hits.map((hit) => hit.chunk.id)).toEqual(['heading', 'text'])
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
      expect(hits[0]!.chunk.versions).toEqual(['1.0.0'])
      expect((await ids('useEff')).toSorted()).toEqual(['heading', 'repo', 'text', 'vue'])
      expect(await ids('useEffect', { name: 'vue' })).toEqual(['vue'])
      expect(await ids('useEffect', { version: '2.0.0' })).toEqual(['repo'])
      expect(await ids('useEffect', { source: 'repository' })).toEqual(['repo'])
      expect(await ids('useEffect', { ecosystem: 'Go' })).toEqual([])
      expect(await ids('useEffect', { path: 'docs/errors.md' })).toEqual([])
      expect(await ids('useEffect', {}, 2)).toHaveLength(2)

      expect(await ids('"Cannot read property"')).toEqual(['phrase'])
      expect((await ids('cannot read property')).toSorted()).toEqual(['phrase', 'scattered'])
      expect((await ids('"cannot read property')).toSorted()).toEqual(['phrase', 'scattered'])
      expect(await ids('"TypeError: Cannot read" map')).toContain('scattered')
      expect(await ids('TypeError:')).toEqual(['phrase'])
      expect(await ids('   ')).toEqual([])
      expect(await ids('"" ()')).toEqual([])
      expect(await ids('nothing-like-this')).toEqual([])
      for (const query of [
        '"',
        'AND',
        'NOT',
        'OR OR',
        'NEAR(x y)',
        'title:x',
        '*',
        'x*',
        '-z',
        '^a',
        "it's",
        '(((',
        '{x}',
        '\\',
        "'",
      ]) {
        expect(Array.isArray(await libs.searchChunks(query))).toBeTrue()
      }
    })

    test('libraries: issues round-trip, replace by id and search title over digest over body', async () => {
      const libs = store.libraries
      if (!libs) return
      const digest = libraryIssue(2, {
        title: 'Build fails',
        body: 'Logs attached.',
        labels: ['bug', 'regression'],
        answer: 'Fixed by the maintainers.',
        pulls: [10, 11],
        fixedIn: '18.3.1',
        reactions: 12,
        comments: 4,
        closedAt: '2026-10-03T00:00:00.000Z',
        digest: {
          problem: 'Hydration error in SSR',
          symptoms: ['Text content does not match server-rendered HTML'],
          affected: '>=18.3.0 <18.3.1',
          fixedIn: '18.3.1',
          workaround: 'Pin 18.2',
          at: '2026-10-04T00:00:00.000Z',
        },
      })
      await libs.putIssues([
        libraryIssue(1, { title: 'Hydration mismatch after upgrade' }),
        digest,
        libraryIssue(3, {
          kind: 'discussion',
          title: 'Question',
          state: 'open',
          body: 'I see hydration warnings in the console whenever the page loads on a slow network.',
          answer: 'Use suppressHydrationWarning.',
        }),
        libraryIssue(4, {
          ...vueLib,
          id: 'github.com/vuejs/core#4',
          title: 'Hydration in Vue',
        }),
      ])

      expect(await libs.getIssue(digest.id)).toEqual(digest)
      expect(await libs.getIssue('github.com/facebook/react#99')).toBeUndefined()
      const ids = async (
        text: string,
        filter?: Parameters<typeof libs.searchIssues>[1],
        limit?: number,
      ) => (await libs.searchIssues(text, filter, limit)).map((hit) => hit.issue.number)
      const hits = await libs.searchIssues('hydration', { name: 'react' })
      expect(hits.map((hit) => hit.issue.number)).toEqual([1, 2, 3])
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
      expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score)
      expect((await ids('hydration')).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4])
      expect(await ids('hydration', { ecosystem: 'npm', name: 'react', state: 'open' })).toEqual([
        3,
      ])
      expect(await ids('hydration', { ecosystem: 'Go' })).toEqual([])
      expect(await ids('hydration', {}, 2)).toHaveLength(2)
      expect(await ids('"does not match"')).toEqual([2])
      expect(await ids('"match does not"')).toEqual([])
      expect(await ids('suppressHydrationWarning')).toEqual([3])
      expect(await ids('pin')).toEqual([2])
      expect(await ids('  ')).toEqual([])
      expect(await ids('" (*)')).toEqual([])

      await libs.putIssues([libraryIssue(1, { title: 'Renamed', state: 'open' })])
      expect((await libs.getIssue(libraryIssue(1).id))?.title).toBe('Renamed')
      expect(await ids('hydration', { name: 'react' })).toEqual([2, 3])
      expect(await ids('renamed', { state: 'open' })).toEqual([1])
      await libs.putIssues([])
    })

    test('libraries: removeLibrary drops its versions, chunks and issues only', async () => {
      const libs = store.libraries
      if (!libs) return
      for (const ref of [reactLib, vueLib]) {
        await libs.putLibrary(libraryRecord(ref))
        await libs.putVersion(libraryVersion(ref, '1.0.0'))
        await libs.replaceChunks(ref, '1.0.0', 'archive', [
          libraryChunk(`${ref.name}-chunk`, { ...ref, text: 'Shared words.' }),
        ])
        await libs.putIssues([
          libraryIssue(1, { ...ref, id: `${ref.name}#1`, title: 'Shared words' }),
        ])
      }

      await libs.removeLibrary(reactLib)
      expect(await libs.getLibrary(reactLib)).toBeUndefined()
      expect(await libs.listVersions(reactLib)).toEqual([])
      expect(await libs.listChunks({ name: 'react' })).toEqual([])
      expect(await libs.getIssue('react#1')).toBeUndefined()
      expect((await libs.searchChunks('shared')).map((hit) => hit.chunk.id)).toEqual(['vue-chunk'])
      expect((await libs.searchIssues('shared')).map((hit) => hit.issue.id)).toEqual(['vue#1'])
      expect(await libs.getLibrary(vueLib)).toBeDefined()
      expect(await libs.listVersions(vueLib)).toHaveLength(1)
    })

    test('libraries: libraryStats counts versions, chunks and issues per library', async () => {
      const libs = store.libraries
      if (!libs) return
      const cobra: LibraryRef = { ecosystem: 'Go', name: 'github.com/spf13/cobra' }
      for (const ref of [reactLib, vueLib, cobra]) await libs.putLibrary(libraryRecord(ref))
      await libs.putVersion(libraryVersion(reactLib, '18.2.0'))
      await libs.putVersion(libraryVersion(reactLib, '19.0.0'))
      await libs.replaceChunks(reactLib, '18.2.0', 'archive', [
        libraryChunk('a'),
        libraryChunk('b'),
      ])
      await libs.replaceChunks(reactLib, '19.0.0', 'archive', [libraryChunk('a')])
      await libs.putIssues([libraryIssue(1), libraryIssue(2)])
      await libs.putVersion(libraryVersion(cobra, 'v1.8.0'))

      const stats = await libs.libraryStats()
      expect(Object.fromEntries(stats)).toEqual({
        'npm:react': { versions: 2, chunks: 2, issues: 2 },
        'npm:vue': { versions: 0, chunks: 0, issues: 0 },
        'Go:github.com/spf13/cobra': { versions: 1, chunks: 0, issues: 0 },
      })
      expect([...(await libs.libraryStats({ ecosystem: 'Go' })).keys()]).toEqual([
        'Go:github.com/spf13/cobra',
      ])
    })

    test('users: avatar seed round-trips', async () => {
      await store.users.putUser(user('u1', { avatarSeed: 'reroll-1' }))
      expect((await store.users.getUser('u1'))?.avatarSeed).toBe('reroll-1')
      await store.users.putUser(user('u1'))
      expect((await store.users.getUser('u1'))?.avatarSeed).toBeUndefined()
    })
  })
}
