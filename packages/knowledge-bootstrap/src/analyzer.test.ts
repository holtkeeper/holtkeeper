import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { MergeRequestRecord, RepoRef } from '@holtkeeper/forge'
import { bootstrapMarker } from '@holtkeeper/knowledge'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  BOOTSTRAP_ACTOR,
  DAILY_RUNS,
  type KnowledgeBootstrapOptions,
  createKnowledgeBootstrapAnalyzer,
  knowledgeBootstrapAnalysis,
} from './analyzer.ts'
import type { BootstrapOutput } from './prompt.ts'

const fixture = join(import.meta.dir, '../../../fixtures/service')
const repo = { forge: 'work', path: 'acme/widget-web' }
const membership: Record<string, string[]> = {
  'work:acme/widget-web': ['shapes.round', 'shapes'],
  'work:acme/widget-api': ['shapes.round', 'shapes'],
  'work:acme/widget-cli': ['shapes.round', 'shapes'],
  'work:acme/kit': ['tools'],
  'work:other/thing': ['tools'],
}
const groupsOf = (target: RepoRef) => membership[`${target.forge}:${target.path}`] ?? []
let dir = ''
let store: Store

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kb-bootstrap-analyzer-'))
  await cp(fixture, dir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))
beforeEach(() => {
  store = memoryStore()
})

const defaultAnswer = (): BootstrapOutput => ({
  lessons: [
    {
      title: 'Run generators through make gen',
      body: 'Mocks and stubs come from `make gen`; files under `gen/` are never edited by hand.',
      kind: 'convention',
      evidence: ['manifests', 'mr:7'],
      level: 'repo',
      repoSpecific: false,
    },
    {
      title: 'Widgets live in memory only',
      body: 'The service keeps widgets in memory; restarts drop them (docs/architecture.md).',
      kind: 'quirk',
      evidence: ['file:docs/architecture.md'],
      level: 'repo',
      repoSpecific: true,
    },
    {
      title: 'Made up',
      body: 'Nothing backs this.',
      kind: 'decision',
      evidence: ['mr:404'],
      level: 'repo',
      repoSpecific: false,
    },
  ],
})

function fakeAgent(answer: (task: AgentTask) => BootstrapOutput | Error = defaultAnswer) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      const output = answer(task)
      if (output instanceof Error) throw output
      return {
        text: '',
        output: task.output?.parse(output),
        turns: 1,
        costUsd: 0.11,
        model: 'model-main',
      }
    },
  }
  return { agent, tasks }
}

const merged = (id: number): MergeRequestRecord => ({
  id,
  title: `Generate mocks with make gen ${id}`,
  description: 'Adds a gen target.',
  sourceBranch: `feature/${id}`,
  targetBranch: 'main',
  state: 'merged',
  draft: false,
  labels: [],
  author: 'dev-one',
  webUrl: `https://forge.test/acme/widget-web/-/merge_requests/${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  mergedAt: '2026-10-02T00:00:00.000Z',
})

const forge = {
  kind: 'gitlab',
  getRepository: async () => ({
    path: repo.path,
    name: 'widget-web',
    defaultBranch: 'main',
    webUrl: 'https://forge.test/acme/widget-web',
    cloneUrl: '',
    archived: false,
  }),
  readFile: async () => undefined,
  listMergeRequests: async () => [merged(7)],
  listDiscussions: async () => [],
}

const analyzer = () =>
  createKnowledgeBootstrapAnalyzer({
    store,
    groupsOf,
    botUsername: () => 'holtkeeper',
    fleetPackages: async () => [
      { subject: 'Go:github.com/example/shapes', repo: { forge: 'work', path: 'acme/kit' } },
    ],
    now: () => new Date('2026-11-13T10:00:00.000Z'),
  })

const run = (
  agent: Agent | undefined,
  options: Partial<KnowledgeBootstrapOptions> = {},
  extra: { ref?: string; lines?: string[]; target?: RepoRef; forge?: unknown } = {},
) =>
  analyzer().run({
    repo: extra.target ?? repo,
    dir,
    runner: createFakeRunner(() => ({ stdout: 'abc123\n' })).runner,
    ...(agent && { agent }),
    forge: (extra.forge ?? forge) as never,
    jobId: 'job-1',
    ...(extra.ref && { ref: extra.ref }),
    ...(extra.lines && { log: (line: string) => extra.lines?.push(line) }),
    options: {
      months: 6,
      maxEntries: 10,
      promote: true,
      maxMergeRequests: 60,
      discussionMergeRequests: 25,
      tier: 'main',
      force: false,
      ...options,
    },
  })

const entryFor = (overrides: Partial<KnowledgeEntry>): KnowledgeEntry => ({
  id: crypto.randomUUID(),
  title: 'Some rule',
  body: 'Some text.',
  kind: 'convention',
  scope: { repos: ['work:acme/widget-api'] },
  topics: [],
  appliesTo: ['*'],
  status: 'accepted',
  source: 'human',
  author: 'jane',
  evidence: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...overrides,
})

const applies = (target: RepoRef = repo) =>
  analyzer().appliesTo?.({ repo: target, forge }) ?? Promise.resolve(true)

describe('knowledge-bootstrap analyzer', () => {
  test('proposes lessons at repo level, never accepted, logs each one and marks the repository', async () => {
    const { agent, tasks } = fakeAgent()
    const lines: string[] = []
    const { data, sha } = await run(agent, {}, { lines })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      taskKind: 'knowledge-bootstrap',
      tier: 'main',
      maxCostUsd: 0.4,
    })
    expect(tasks[0]?.prompt).toContain('[mr:7] !7 Generate mocks with make gen 7')
    expect(tasks[0]?.prompt).toContain('Go:github.com/example/shapes → work:acme/kit')
    expect(sha).toBe('abc123')
    expect(data.outcome).toBe('proposed')
    expect(data.window).toEqual({
      since: '2026-05-13T10:00:00.000Z',
      mergeRequests: 1,
      discussions: 1,
    })
    expect(data.lessons.map((lesson) => [lesson.title, lesson.level, lesson.outcome])).toEqual([
      ['Made up', undefined, 'dropped'],
      ['Run generators through make gen', 'repo', 'created'],
      ['Widgets live in memory only', 'repo', 'created'],
    ])
    expect(data.call).toMatchObject({ model: 'model-main', costUsd: 0.11 })

    const entries = await store.knowledge.list()
    expect(entries).toHaveLength(2)
    for (const entry of entries)
      expect(entry).toMatchObject({
        status: 'proposed',
        source: 'agent',
        author: BOOTSTRAP_ACTOR,
        scope: { repos: ['work:acme/widget-web'] },
        appliesTo: ['*'],
      })
    const gen = entries.find((entry) => entry.title.startsWith('Run generators'))
    expect(gen?.evidence.map((link) => link.url)).toEqual([
      'https://forge.test/acme/widget-web/-/tree/abc123',
      'https://forge.test/acme/widget-web/-/merge_requests/7',
    ])

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^budget: estimate \$0\.\d\d, cap \$0\.40/),
        'dropped "Made up" — no known evidence',
        'proposed [repo] "Run generators through make gen" — no matching entry in its groups',
        'proposed [repo] "Widgets live in memory only" — specific to this repository',
        'proposed 2 entries, 0 above the repository; marked as bootstrapped',
      ]),
    )
    expect(await store.kv?.get(bootstrapMarker(repo))).toEqual({
      at: '2026-11-13T10:00:00.000Z',
      jobId: 'job-1',
      proposed: 2,
      promoted: 0,
      reason: 'bootstrapped',
    })
    const report = knowledgeBootstrapAnalysis.toReport({
      id: 'a1',
      kind: 'knowledge-bootstrap',
      repo,
      createdAt: '2026-11-13T10:00:00.000Z',
      data,
    })
    expect(report.metrics.map((item) => [item.id, item.value])).toEqual([
      ['proposed', 2],
      ['promoted', 0],
      ['cost', 0.11],
    ])
  })

  test('a marked repository is skipped until forced', async () => {
    const first = fakeAgent()
    await run(first.agent)
    expect(await applies()).toBeFalse()
    const again = fakeAgent()
    const skipped = await run(again.agent)
    expect(skipped.data).toMatchObject({ outcome: 'skipped' })
    expect(skipped.data.reason).toContain(
      'already bootstrapped 2026-11-13T10:00:00.000Z (job job-1)',
    )
    expect(again.tasks).toHaveLength(0)

    const forced = await run(again.agent, { force: true })
    expect(forced.data.outcome).toBe('proposed')
    expect(again.tasks).toHaveLength(1)
    expect(forced.data.lessons.map((lesson) => lesson.outcome)).toEqual([
      'dropped',
      'covered',
      'covered',
    ])
    expect(await store.knowledge.list()).toHaveLength(2)
  })

  test('a repository with entries of its own is marked and skipped without a call', async () => {
    await store.knowledge.put(
      entryFor({ scope: { repos: ['acme/widget-web'] }, status: 'proposed' }),
    )
    expect(await applies()).toBeFalse()
    const { agent, tasks } = fakeAgent()
    const { data } = await run(agent)
    expect(data).toMatchObject({
      outcome: 'skipped',
      reason: 'the repository already has knowledge entries of its own',
    })
    expect(tasks).toHaveLength(0)
    expect(await store.kv?.get(bootstrapMarker(repo))).toMatchObject({ reason: 'has-entries' })
  })

  test('group, glob and rejected entries do not count as entries of the repository', async () => {
    await store.knowledge.put(entryFor({ scope: { groups: ['shapes.round'] } }))
    await store.knowledge.put(entryFor({ scope: { repos: ['work:acme/widget-*'] } }))
    await store.knowledge.put(
      entryFor({ scope: { repos: ['work:acme/widget-web'] }, status: 'rejected' }),
    )
    expect(await applies()).toBeTrue()
    expect(await createKnowledgeBootstrapAnalyzer().appliesTo?.({ repo, forge })).toBeTrue()
  })

  test('automatic runs are limited per day', () => {
    expect(analyzer().dailyLimit).toBe(DAILY_RUNS)
  })

  test('a budget refusal propagates with nothing stored and no marker', async () => {
    const { agent } = fakeAgent(() => new BudgetExceededError('AI budget exceeded'))
    const failed = await run(agent).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(BudgetExceededError)
    expect(await store.knowledge.list()).toEqual([])
    expect(await store.kv?.get(bootstrapMarker(repo))).toBeUndefined()
    expect(await applies()).toBeTrue()
  })

  test('without an agent it skips without a marker; a ref or a missing store is refused', async () => {
    const { data } = await run(undefined)
    expect(data).toMatchObject({ outcome: 'skipped', reason: 'no AI agent is configured' })
    expect(await store.kv?.get(bootstrapMarker(repo))).toBeUndefined()
    expect(
      String(await run(fakeAgent().agent, {}, { ref: 'v1.0.0' }).catch((e: unknown) => e)),
    ).toContain('reads only the default branch')
    const bare = createKnowledgeBootstrapAnalyzer()
    const refused = await bare
      .run({ repo, dir, runner: createFakeRunner().runner, options: {} as never })
      .catch((error: unknown) => error)
    expect(String(refused)).toContain('needs the server knowledge store')
  })

  test('a lesson a sibling already has becomes a subgroup proposal that supersedes it', async () => {
    const sibling = await store.knowledge.put(
      entryFor({
        title: 'Run generators through make gen',
        body: 'Mocks are generated by `make gen`; never edit `gen/` by hand.',
        evidence: [{ label: '!3', url: 'https://forge.test/acme/widget-api/-/merge_requests/3' }],
      }),
    )
    const { agent, tasks } = fakeAgent((task) => {
      expect(task.prompt).toContain(`kb:${sibling.id} [repo work:acme/widget-api]`)
      return {
        lessons: [
          {
            title: 'Run generators through make gen',
            body: 'Mocks come from `make gen`.',
            kind: 'convention',
            evidence: ['mr:7'],
            level: 'repo',
            repoSpecific: false,
            related: [sibling.id],
            general: {
              title: 'Generate mocks and stubs with make gen',
              body: 'Services of the round team generate mocks and stubs with `make gen` and never edit `gen/` by hand.',
            },
          },
        ],
      }
    })
    const lines: string[] = []
    const { data } = await run(agent, {}, { lines })
    expect(tasks).toHaveLength(1)
    expect(data.lessons).toEqual([
      expect.objectContaining({
        level: 'subgroup',
        scope: 'subgroup shapes.round',
        outcome: 'created',
        supersedes: sibling.id,
      }),
    ])
    const promoted = (await store.knowledge.list({ status: 'proposed' }))[0]
    expect(promoted).toMatchObject({
      title: 'Generate mocks and stubs with make gen',
      scope: { groups: ['shapes.round'] },
      supersedes: sibling.id,
      status: 'proposed',
    })
    expect(promoted?.evidence.map((link) => link.url)).toEqual([
      'https://forge.test/acme/widget-web/-/merge_requests/7',
      'https://forge.test/acme/widget-api/-/merge_requests/3',
    ])
    expect(lines.find((line) => line.startsWith('proposed ['))).toStartWith(
      'proposed [subgroup shapes.round] "Generate mocks and stubs with make gen" — a sibling in shapes.round has it',
    )
    expect(await store.kv?.get(bootstrapMarker(repo))).toMatchObject({ proposed: 1, promoted: 1 })
  })

  test('promote off keeps everything at the repository', async () => {
    await store.knowledge.put(
      entryFor({ title: 'Run code generators via make gen', body: 'Stubs come from make gen.' }),
    )
    const { agent } = fakeAgent()
    const { data } = await run(agent, { promote: false })
    expect(
      data.lessons.filter((lesson) => lesson.outcome === 'created').map((lesson) => lesson.level),
    ).toEqual(['repo', 'repo'])
  })

  test('a promotion over two siblings with the same lesson is created, not swallowed by one of them', async () => {
    const api = await store.knowledge.put(
      entryFor({
        title: 'Run generators through make gen',
        body: 'Mocks are generated by `make gen`.',
        scope: { repos: ['work:acme/widget-api'] },
        updatedAt: '2026-10-02T00:00:00.000Z',
      }),
    )
    const cli = await store.knowledge.put(
      entryFor({
        title: 'Run generators through make gen',
        body: 'Stubs are generated by `make gen`.',
        scope: { repos: ['work:acme/widget-cli'] },
      }),
    )
    const { agent } = fakeAgent(() => ({
      lessons: [
        {
          title: 'Run generators through make gen',
          body: 'Mocks come from `make gen`.',
          kind: 'convention',
          evidence: ['mr:7'],
          level: 'repo',
          repoSpecific: false,
        },
      ],
    }))
    const { data } = await run(agent)
    expect(data.lessons).toEqual([
      expect.objectContaining({ level: 'subgroup', outcome: 'created', supersedes: api.id }),
    ])
    const promoted = await store.knowledge.list({ status: 'proposed' })
    expect(promoted).toHaveLength(1)
    expect(promoted[0]).toMatchObject({ scope: { groups: ['shapes.round'] }, supersedes: api.id })
    expect(promoted[0]?.title).toBe('Run generators through make gen')
    expect((await store.knowledge.get(cli.id))?.evidence).toEqual([])
  })

  test('an entry of another team with the same title is no duplicate of a lesson here', async () => {
    const other = await store.knowledge.put(
      entryFor({
        title: 'Run generators through make gen',
        body: 'Mocks and stubs come from `make gen`; files under `gen/` are never edited by hand.',
        scope: { repos: ['work:other/thing'] },
      }),
    )
    const { data } = await run(fakeAgent().agent)
    expect(data.lessons.find((lesson) => lesson.title.startsWith('Run generators'))).toMatchObject({
      level: 'repo',
      outcome: 'created',
    })
    expect((await store.knowledge.get(other.id))?.evidence).toEqual([])
  })

  test('library lessons other runs scoped to a repository do not count as its own entries', async () => {
    const kit = { forge: 'work', path: 'acme/kit' }
    await store.knowledge.put(
      entryFor({
        scope: { repos: ['work:acme/kit'] },
        subject: 'Go:github.com/example/shapes',
        source: 'agent',
        author: BOOTSTRAP_ACTOR,
        status: 'proposed',
      }),
    )
    expect(await applies(kit)).toBeTrue()
    await store.knowledge.put(
      entryFor({ scope: { repos: ['work:acme/kit'] }, source: 'agent', author: BOOTSTRAP_ACTOR }),
    )
    expect(await applies(kit)).toBeFalse()
  })

  test('a covering entry deleted during the run drops the lesson', async () => {
    await store.knowledge.put(
      entryFor({
        title: 'Run generators through make gen',
        body: 'Mocks come from `make gen`.',
        scope: { groups: ['shapes.round'] },
      }),
    )
    const inner = store
    store = { ...inner, knowledge: { ...inner.knowledge, get: async () => undefined } }
    const { data } = await run(fakeAgent().agent)
    expect(data.lessons).toContainEqual({
      title: 'Run generators through make gen',
      outcome: 'dropped',
      why: 'the covering entry is gone',
    })
  })

  test('a lesson the entry rules refuse is dropped with the issues', async () => {
    const lines: string[] = []
    const broken = {
      ...forge,
      listMergeRequests: async () => [{ ...merged(7), webUrl: 'not a link' }],
    }
    const { agent } = fakeAgent(() => ({
      lessons: [
        {
          title: 'Squash before merge',
          body: 'Reviewers ask for one commit per merge request.',
          kind: 'convention',
          evidence: ['mr:7'],
          level: 'process',
          repoSpecific: false,
        },
      ],
    }))
    const { data } = await run(agent, {}, { lines, forge: broken })
    expect(data.lessons).toEqual([
      expect.objectContaining({ title: 'Squash before merge', level: 'repo', outcome: 'dropped' }),
    ])
    expect(data.lessons[0]?.why).toContain('evidence')
    expect(lines.some((line) => line.startsWith('dropped "Squash before merge"'))).toBeTrue()
    expect(await store.knowledge.list()).toEqual([])
  })
})
