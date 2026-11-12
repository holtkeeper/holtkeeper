import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import type { ConventionsForge } from '@holtkeeper/commit-conventions'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { CommitRecord } from '@holtkeeper/forge'
import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { type GuideGeneratorOptions, createGuideAnalyzer } from './analyzer.ts'
import { DETERMINISTIC_MODEL } from './generate.ts'
import { GENERATOR_CONTEXT, type GeneratorOutput } from './prompt.ts'
import { rememberGuideRejection } from './rejections.ts'

const fixture = join(import.meta.dir, '../../../fixtures/service')
const repo = { forge: 'work', path: 'shapes/service' }
const repoScope = 'repo:work:shapes/service'
let dir = ''
let store: Store

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guide-analyzer-'))
  await cp(fixture, dir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))
beforeEach(() => {
  store = memoryStore()
})

function fakeAgent(answer: (task: AgentTask) => GeneratorOutput = defaultAnswer) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      const output = answer(task)
      return {
        text: JSON.stringify(output),
        output: task.output?.parse(output),
        turns: 1,
        costUsd: 0.04,
        model: task.tier === 'main' ? 'model-main' : 'model-fast',
      }
    },
  }
  return { agent, tasks }
}

const defaultAnswer = (task: AgentTask): GeneratorOutput => ({
  sections: {
    ...(task.prompt.includes('# Section general') && {
      general: ['- Run `make lint` and `make test` before pushing; CI runs both.', ''],
    }),
    ...(task.prompt.includes('# Section testing') && {
      testing: ['Put tests next to the code as `{name}_test.go`.'],
    }),
  },
})

const commitTitles = Array.from({ length: 12 }, (_, i) => `feat: add shape ${i}`)
const forge: ConventionsForge = {
  getRepository: async (path) => ({
    path,
    name: path,
    defaultBranch: 'main',
    webUrl: '',
    cloneUrl: '',
    archived: false,
  }),
  readFile: async () => undefined,
  listCommits: async () =>
    commitTitles.map((title, i): CommitRecord => ({
      sha: `s${i}`,
      parents: ['p'],
      authorName: 'A',
      authorEmail: 'a@example.com',
      authoredAt: '2026-10-01T00:00:00Z',
      title,
      message: title,
    })),
  listBranches: async () => [],
}

const run = (
  agent: Agent | undefined,
  options: Partial<GuideGeneratorOptions> = {},
  extra: { forge?: ConventionsForge; jobId?: string } = {},
) =>
  createGuideAnalyzer({ store, groupsOf: () => ['shapes'] }).run({
    repo,
    dir,
    runner: createFakeRunner(() => ({ stdout: 'abc123\n' })).runner,
    ...(agent && { agent }),
    ...(extra.forge && { forge: extra.forge as never }),
    ...(extra.jobId && { jobId: extra.jobId }),
    history: { analyses: store.analyses, auditRuns: store.auditRuns },
    options: { force: false, ...options },
  })

test('proposes general and testing in one main-tier call and stores model, cost and commit', async () => {
  const { agent, tasks } = fakeAgent()
  const { data, sha } = await run(agent)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ tier: 'main', capabilities: [], taskKind: 'guide' })
  expect(tasks[0]?.context).toBe(GENERATOR_CONTEXT)
  expect(tasks[0]?.system).toContain('No generic best practices')
  expect(tasks[0]?.prompt).toContain('[ci] CI configuration')
  expect(sha).toBe('abc123')
  expect(data.call).toEqual({
    tier: 'main',
    model: 'model-main',
    costUsd: 0.04,
    sections: ['general', 'testing'],
  })
  expect(data.sections.map((section) => [section.section, section.outcome])).toEqual([
    ['general', 'proposed'],
    ['testing', 'proposed'],
    ['testids', 'skipped'],
    ['commits', 'skipped'],
  ])
  const general = await store.guides.get(repoScope, 'general')
  expect(general?.generated).toMatchObject({
    body: '- Run `make lint` and `make test` before pushing; CI runs both.',
    model: 'model-main',
    costUsd: 0.02,
    status: 'proposed',
    sha: 'abc123',
  })
  expect(general?.version).toBe(0)
})

test('a repository with no tests by design skips testing without asking the model about it', async () => {
  const { agent, tasks } = fakeAgent()
  const { data } = await createGuideAnalyzer({
    store,
    groupsOf: () => ['shapes'],
    testsExpected: async () => false,
  }).run({
    repo,
    dir,
    runner: createFakeRunner(() => ({ stdout: 'abc123\n' })).runner,
    agent,
    history: { analyses: store.analyses, auditRuns: store.auditRuns },
    options: { force: false },
  })
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.prompt).not.toContain('# Section testing')
  expect(data.sections.map((section) => [section.section, section.outcome])).toEqual([
    ['general', 'proposed'],
    ['testing', 'skipped'],
    ['testids', 'skipped'],
    ['commits', 'skipped'],
  ])
  expect(data.sections[1]).toEqual({
    section: 'testing',
    outcome: 'skipped',
    reason: 'no tests by design',
    evidence: [],
  })
  expect(await store.guides.get(repoScope, 'testing')).toBeUndefined()
})

test('a second run over the same evidence makes no call', async () => {
  await run(fakeAgent().agent)
  const { agent, tasks } = fakeAgent()
  const { data } = await run(agent)
  expect(tasks).toHaveLength(0)
  expect(data.call).toBeUndefined()
  expect(data.sections.slice(0, 2).map((section) => section.outcome)).toEqual([
    'unchanged',
    'unchanged',
  ])
})

test('a forced run does not propose again what a person rejected', async () => {
  await run(fakeAgent().agent)
  const general = await store.guides.get(repoScope, 'general')
  await rememberGuideRejection(store.kv!, repoScope, 'general', {
    inputHash: general!.generated!.inputHash,
    generatedAt: general!.generated!.generatedAt,
    by: 'user:a',
    at: '2026-11-01T00:00:00.000Z',
  })
  const { agent, tasks } = fakeAgent()
  const { data } = await run(agent, { force: true })
  expect(data.sections.slice(0, 2).map((section) => [section.section, section.outcome])).toEqual([
    ['general', 'skipped'],
    ['testing', 'proposed'],
  ])
  expect(data.sections[0]?.reason).toBe('a person rejected text from these inputs')
  expect(tasks[0]?.prompt).not.toContain('# Section general')
})

test('changed steering regenerates only that section, on the fast tier when general is unchanged', async () => {
  await run(fakeAgent().agent)
  const testing = await store.guides.get(repoScope, 'testing')
  await store.guides.put({
    scope: 'group:shapes',
    section: 'testing',
    rules: 'Table-driven tests only.',
    steering: 'Mention the race detector.',
    learnings: [],
    editedBy: 'jane',
    editedAt: '2026-11-01T10:00:00.000Z',
  })
  const { agent, tasks } = fakeAgent()
  const { data } = await run(agent)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]?.tier).toBe('fast')
  expect(tasks[0]?.prompt).toContain('Team steering (follow it):\nMention the race detector.')
  expect(tasks[0]?.prompt).toContain('Table-driven tests only.')
  expect(tasks[0]?.prompt).not.toContain('# Section general')
  expect(data.call?.sections).toEqual(['testing'])
  const regenerated = await store.guides.get(repoScope, 'testing')
  expect(regenerated?.generated?.inputHash).not.toBe(testing?.generated?.inputHash)
  expect(regenerated?.generated?.model).toBe('model-fast')
})

test('a budget stop propagates and keeps the stored Guide as it was', async () => {
  const agent: Agent = {
    name: 'fake',
    run: async () => {
      throw new BudgetExceededError('AI budget exceeded: automatic work stops at the reserve')
    },
  }
  const error = await run(agent).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(BudgetExceededError)
  expect(await store.guides.list()).toEqual([])
})

test('new text over accepted text becomes a proposal; equal text keeps the accepted layer', async () => {
  await run(fakeAgent().agent)
  const first = await store.guides.get(repoScope, 'general')
  if (!first?.generated) throw new Error('no generated layer')
  await store.guides.put({
    ...first,
    generated: { ...first.generated, status: 'accepted', acceptedBy: 'jane' },
  })

  const same = await run(fakeAgent().agent, { force: true, sections: ['general'] })
  expect(same.data.sections[0]?.outcome).toBe('kept')
  expect((await store.guides.get(repoScope, 'general'))?.proposal).toBeUndefined()

  const empty = await run(fakeAgent(() => ({ sections: {} })).agent, {
    force: true,
    sections: ['general'],
  })
  expect(empty.data.sections[0]?.outcome).toBe('kept')
  expect((await store.guides.get(repoScope, 'general'))?.proposal).toBeUndefined()

  const { agent } = fakeAgent(() => ({ sections: { general: ['Run `make build` to build.'] } }))
  const changed = await run(agent, {
    force: true,
    sections: ['general'],
    prompt: 'Mention the build target.',
  })
  expect(changed.data.prompt).toBe('Mention the build target.')
  const stored = await store.guides.get(repoScope, 'general')
  expect(stored?.generated).toMatchObject({ status: 'accepted', acceptedBy: 'jane' })
  expect(stored?.proposal).toMatchObject({
    body: '- Run `make build` to build.',
    status: 'proposed',
    prompt: 'Mention the build target.',
  })
})

test('sections the policy lists are stored accepted by auto-accept and audited; others stay proposed', async () => {
  const asked: string[] = []
  await createGuideAnalyzer({
    store,
    groupsOf: () => ['shapes'],
    autoAccept: async (target) => {
      asked.push(target.path)
      return ['general']
    },
  }).run({
    repo,
    dir,
    runner: createFakeRunner(() => ({ stdout: 'abc123\n' })).runner,
    agent: fakeAgent().agent,
    jobId: 'job-7',
    history: { analyses: store.analyses, auditRuns: store.auditRuns },
    options: { force: false },
  })
  expect(asked).toEqual(['shapes/service'])
  const general = await store.guides.get(repoScope, 'general')
  expect(general?.generated).toMatchObject({ status: 'accepted', acceptedBy: 'auto-accept' })
  expect(general?.proposal).toBeUndefined()
  expect((await store.guides.get(repoScope, 'testing'))?.generated?.status).toBe('proposed')
  const events = await store.audit.list({ action: 'guide.accept' })
  expect(events.events).toMatchObject([
    {
      actor: { id: 'auto-accept' },
      target: { type: 'guide', id: `${repoScope}/general`, repo: 'work:shapes/service' },
      details: { auto: true, jobId: 'job-7' },
    },
  ])
})

test('every stored run gets the next version and its job, and lands in the generated history', async () => {
  await run(fakeAgent().agent, { sections: ['general'] }, { jobId: 'job-1' })
  const first = await store.guides.get(repoScope, 'general')
  expect(first?.generated).toMatchObject({ version: 1, jobId: 'job-1', status: 'proposed' })
  await store.guides.put({
    ...first!,
    generated: { ...first!.generated!, status: 'accepted', acceptedBy: 'jane' },
  })

  const { agent } = fakeAgent(() => ({ sections: { general: ['Run `make build` to build.'] } }))
  await run(agent, { force: true, sections: ['general'] }, { jobId: 'job-2' })
  const second = await store.guides.get(repoScope, 'general')
  expect(second?.generated).toMatchObject({ version: 1, status: 'accepted' })
  expect(second?.proposal).toMatchObject({ version: 2, jobId: 'job-2', status: 'proposed' })

  const history = await store.guides.generatedHistory(repoScope, 'general')
  expect(history.map((layer) => [layer.version, layer.jobId, layer.status])).toEqual([
    [2, 'job-2', 'proposed'],
    [1, 'job-1', 'accepted'],
  ])
})

test('the extra prompt reaches the model', async () => {
  const { agent, tasks } = fakeAgent()
  await run(agent, { prompt: 'Name the web folder.' })
  expect(tasks[0]?.prompt).toContain(
    'Extra request for this run (from a maintainer):\nName the web folder.',
  )
})

test('commits are written from inferred conventions without an LLM, and only once', async () => {
  const { agent, tasks } = fakeAgent()
  const { data } = await run(agent, { sections: ['commits'] }, { forge })
  expect(tasks).toHaveLength(0)
  expect(data.sections[0]?.outcome).toBe('proposed')
  const commits = await store.guides.get(repoScope, 'commits')
  expect(commits?.generated).toMatchObject({ model: DETERMINISTIC_MODEL, costUsd: 0 })
  expect(commits?.generated?.body).toContain('Conventional Commits')
  const again = await run(agent, { sections: ['commits'] }, { forge })
  expect(again.data.sections[0]?.outcome).toBe('unchanged')
})

test('without an agent LLM sections are skipped and nothing is stored for them', async () => {
  const { data } = await run(undefined, { sections: ['general'] })
  expect(data.sections[0]).toMatchObject({
    outcome: 'skipped',
    reason: 'no AI agent is configured',
  })
  expect(await store.guides.list()).toEqual([])
})

test('refuses to run without the Guide store', async () => {
  const error = await createGuideAnalyzer()
    .run({ repo, dir, runner: createFakeRunner().runner, options: { force: false } })
    .catch((caught: unknown) => caught)
  expect(String(error)).toContain('Guide store')
})
