import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import { freshnessKey, readFreshness } from '@holtkeeper/knowledge'
import type { KnowledgeEntry, Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import type { VerifyOutput } from './verify-prompt.ts'
import {
  type KnowledgeVerifyOptions,
  VERIFY_ACTOR,
  createKnowledgeVerifyAnalyzer,
  verifiableEntries,
} from './verify.ts'

const repo = { forge: 'work', path: 'acme/web' }
const now = new Date('2026-11-13T10:00:00.000Z')
let dir = ''
let store: Store

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kb-verify-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/loader.ts'), 'export const load = () => 1\n')
  await mkdir(join(dir, '.github/workflows'), { recursive: true })
  await writeFile(join(dir, '.github/workflows/ci.yml'), 'on: push\n')
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'web', dependencies: { widget: '^1.0.0' } }),
  )
})
afterAll(() => rm(dir, { recursive: true, force: true }))
beforeEach(() => {
  store = memoryStore()
})

const entryFor = (id: string, extra: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  title: `Rule ${id}`,
  body: 'Load widgets lazily.',
  kind: 'convention',
  scope: { repos: ['work:acme/web'] },
  topics: [],
  appliesTo: ['*'],
  visibility: 'team',
  status: 'accepted',
  source: 'human',
  author: 'jane',
  evidence: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  version: 1,
  ...extra,
})

const link = (path: string) => ({
  label: path,
  url: `https://forge.test/acme/web/-/blob/old111/${path}`,
})

const seed = async (...entries: KnowledgeEntry[]) => {
  for (const { version: _, ...entry } of entries) await store.knowledge.put(entry)
}

function fakeAgent(answer: (task: AgentTask) => VerifyOutput | Error) {
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
        costUsd: 0.02,
        model: 'model-fast',
      }
    },
  }
  return { agent, tasks }
}

const run = (
  agent: Agent | undefined,
  options: Partial<KnowledgeVerifyOptions> = {},
  head = 'new222',
  diffs: string[][] = [],
) =>
  createKnowledgeVerifyAnalyzer({ store, now: () => now }).run({
    repo,
    dir,
    runner: createFakeRunner((command) => {
      if (command[1] === 'rev-parse') return { stdout: `${head}\n` }
      if (command.includes('--name-only')) {
        diffs.push(command)
        return { stdout: 'src/loader.ts\n' }
      }
      if (command.includes('--unified=2')) return { stdout: '-old\n+new\n' }
      return undefined
    }).runner,
    ...(agent && { agent }),
    options: { tier: 'fast', force: false, ...options },
  })

const stored = async (id: string) => (await readFreshness(store.kv, [id])).get(id)

describe('verifiableEntries', () => {
  test('keeps accepted entries naming the repository or citing its files', () => {
    const entries = [
      entryFor('named'),
      entryFor('cited', { scope: { teams: ['widgets'] }, evidence: [link('src/loader.ts')] }),
      entryFor('broad', { scope: { all: true } }),
      entryFor('proposed', { status: 'proposed' }),
    ]
    expect(verifiableEntries(entries, repo).map((entry) => entry.id)).toEqual(['named', 'cited'])
  })
})

describe('knowledge-verify analyzer', () => {
  test('skips a repository nothing rests on, still reporting the commit', async () => {
    const result = await run(undefined)
    expect(result.data).toMatchObject({ outcome: 'skipped', records: [] })
    expect(result.sha).toBe('new222')
  })

  test('confirms entries nothing changed for without a model, once per commit', async () => {
    await seed(entryFor('calm', { evidence: [link('src/loader.ts')] }))
    const { agent, tasks } = fakeAgent(() => ({ verdicts: [] }))
    const first = await run(agent)
    expect(tasks).toHaveLength(0)
    expect(first.data.records).toEqual([{ id: 'calm', title: 'Rule calm', outcome: 'unchanged' }])
    expect(await stored('calm')).toMatchObject({
      status: 'fresh',
      method: 'signals',
      sha: 'new222',
    })
  })

  test('judges flagged entries: valid, obsolete, and update as a superseding proposal', async () => {
    await seed(
      entryFor('ok', { evidence: [link('src/loader.ts')] }),
      entryFor('gone', { evidence: [link('src/missing.ts')] }),
      entryFor('old', { subject: 'npm:retired' }),
    )
    await store.kv?.set(freshnessKey('ok'), {
      status: 'fresh',
      checkedAt: '2026-11-02T00:00:00.000Z',
      sha: 'old111',
      method: 'signals',
      repo: 'work:acme/web',
      signals: [],
    })
    const { agent, tasks } = fakeAgent(() => ({
      verdicts: [
        { id: 'ok', verdict: 'valid', reason: 'the diff only renames a variable' },
        { id: 'gone', verdict: 'obsolete', reason: 'the loader was removed' },
        {
          id: 'old',
          verdict: 'update',
          reason: 'retired is no longer a dependency',
          title: 'Load widgets lazily (no retired lib)',
          body: 'Load widgets lazily with the built-in loader.',
        },
        { id: 'nonexistent', verdict: 'valid', reason: 'ignored' },
      ],
    }))
    const { data } = await run(agent)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ taskKind: 'knowledge-verify', tier: 'fast', capabilities: [] })
    expect(tasks[0]?.prompt).toContain('diff of src/loader.ts')
    expect(tasks[0]?.prompt).toContain('src/missing.ts no longer exists')
    const byId = new Map(data.records.map((record) => [record.id, record]))
    expect(byId.get('ok')?.outcome).toBe('valid')
    expect(byId.get('gone')?.outcome).toBe('obsolete')
    expect(byId.get('old')?.outcome).toBe('updated')
    expect(await stored('ok')).toMatchObject({ status: 'fresh', method: 'model' })
    expect(await stored('gone')).toMatchObject({
      status: 'stale',
      reason: 'the loader was removed',
    })

    const proposal = byId.get('old')?.proposal
    expect(proposal).toBeDefined()
    const created = await store.knowledge.get(proposal ?? '')
    expect(created).toMatchObject({
      status: 'proposed',
      author: VERIFY_ACTOR,
      supersedes: 'old',
      scope: { repos: ['work:acme/web'] },
    })
    // Nothing is archived or edited by the run itself.
    expect((await store.knowledge.get('old'))?.status).toBe('accepted')
    expect(await stored('old')).toMatchObject({ status: 'suspect', proposal })
  })

  test('a stale verdict stays until something new happens', async () => {
    await seed(entryFor('gone', { evidence: [link('src/missing.ts')] }))
    await store.kv?.set(freshnessKey('gone'), {
      status: 'stale',
      checkedAt: '2026-11-12T00:00:00.000Z',
      judgedAt: '2026-11-12T00:00:00.000Z',
      sha: 'new222',
      method: 'model',
      repo: 'work:acme/web',
      reason: 'removed',
      signals: [],
    })
    await store.kv?.set(freshnessKey('calm'), {
      status: 'stale',
      checkedAt: '2026-11-12T00:00:00.000Z',
      sha: 'old111',
      method: 'model',
      repo: 'work:acme/web',
      signals: [],
    })
    await seed(entryFor('calm'))
    const { agent, tasks } = fakeAgent(() => ({ verdicts: [] }))
    // `gone` still has its missing file, so it is judged again; `calm` has no signal and stays stale.
    await run(agent)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.prompt).not.toContain('### calm')
    expect(await stored('calm')).toMatchObject({ status: 'stale', sha: 'old111' })
  })

  test('evidence in dot folders exists; the first check diffs from the evidence commit', async () => {
    const sha = 'c'.repeat(40)
    await seed(
      entryFor('ci', {
        evidence: [
          {
            label: 'ci',
            url: `https://forge.test/acme/web/-/blob/${sha}/.github/workflows/ci.yml`,
          },
        ],
      }),
      entryFor('code', {
        evidence: [{ label: 'l', url: `https://forge.test/acme/web/-/blob/${sha}/src/loader.ts` }],
      }),
    )
    const diffs: string[][] = []
    const { agent, tasks } = fakeAgent(() => ({ verdicts: [] }))
    const { data } = await run(agent, {}, 'new222', diffs)
    expect(diffs).toEqual([['git', 'diff', '--name-only', sha, 'HEAD']])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.prompt).toContain('### code')
    expect(tasks[0]?.prompt).not.toContain('### ci')
    expect(data.records.find((record) => record.id === 'ci')?.outcome).toBe('unchanged')
    expect(await stored('ci')).toMatchObject({ status: 'fresh', judgedAt: now.toISOString() })
  })

  test('aged counts from the last judgement, not from daily signal checks', async () => {
    await seed(entryFor('calm'))
    await store.kv?.set(freshnessKey('calm'), {
      status: 'fresh',
      checkedAt: '2026-11-12T00:00:00.000Z',
      judgedAt: '2026-07-01T00:00:00.000Z',
      sha: 'old111',
      method: 'signals',
      repo: 'work:acme/web',
      signals: [],
    })
    const { agent, tasks } = fakeAgent(() => ({
      verdicts: [{ id: 'calm', verdict: 'valid', reason: 'still true' }],
    }))
    await run(agent)
    expect(tasks[0]?.prompt).toContain('aged: 90+ days')
    expect(await stored('calm')).toMatchObject({ status: 'fresh', judgedAt: now.toISOString() })
  })

  test('without an agent flagged entries are marked suspect', async () => {
    await seed(entryFor('gone', { evidence: [link('src/missing.ts')] }))
    const { data } = await run(undefined)
    expect(data.records[0]?.outcome).toBe('flagged')
    expect(await stored('gone')).toMatchObject({ status: 'suspect', method: 'signals' })
  })

  test('a model answer without a verdict defers the entry; a budget stop propagates', async () => {
    await seed(entryFor('gone', { evidence: [link('src/missing.ts')] }))
    const silent = fakeAgent(() => ({ verdicts: [] }))
    expect((await run(silent.agent)).data.records[0]?.outcome).toBe('deferred')
    expect(await stored('gone')).toBeUndefined()

    const stop = fakeAgent(() => new BudgetExceededError('weekly budget'))
    const error = await run(stop.agent).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BudgetExceededError)
  })
})
