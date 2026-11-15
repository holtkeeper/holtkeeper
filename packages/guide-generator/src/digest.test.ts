import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Agent, type AgentTask, BudgetExceededError } from '@holtkeeper/agent'
import { DIGEST_MIN_CHARS, digestKey, readRepoDigests } from '@holtkeeper/guide'
import { memoryStore } from '@holtkeeper/store/memory'

import { acceptDigest, digestRepoFiles, headingsOf } from './digest.ts'

const doc = `# Contributing\n\n## Testing\n\nRun make test.\n\n## Style\n\n${'Prose. '.repeat(600)}`

function fakeAgent(answer: unknown = defaultAnswer, fail?: Error) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      if (fail) throw fail
      return { output: answer as Output, model: 'fake-model', costUsd: 0.01 } as never
    },
  }
  return { agent, tasks }
}

const defaultAnswer = {
  general: [{ text: '- Run make test.', source: 'Testing' }],
  review: [{ text: 'Run make test.', source: 'Nowhere' }],
  code: [{ text: 'Keep prose short.', source: '## style' }],
}

const checkout = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'digest-'))
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
  return dir
}

describe('acceptDigest', () => {
  test('cleans lines, drops duplicates and unknown sources', () => {
    const out = acceptDigest(defaultAnswer, doc)
    expect(out.general).toEqual([{ text: 'Run make test.', source: 'Testing' }])
    // Same line again in another group is a duplicate.
    expect(out.review).toEqual([])
    expect(out.code).toEqual([{ text: 'Keep prose short.', source: 'style' }])
  })

  test('keeps a line whose source is not a heading, without the source', () => {
    const out = acceptDigest(
      { general: [{ text: 'Use bun.', source: 'Made up' }], review: [], code: [] },
      doc,
    )
    expect(out.general).toEqual([{ text: 'Use bun.' }])
  })

  test('headingsOf lowercases headings', () => {
    expect([...headingsOf('# A b\ntext\n### C ###')]).toEqual(['a b', 'c'])
  })
})

describe('digestRepoFiles', () => {
  const base = { forgeId: 'work', repo: 'acme/web' }

  test('digests long files once and skips them while the sha holds', async () => {
    const { kv } = memoryStore()
    const dir = await checkout({ 'CONTRIBUTING.md': doc, 'AGENTS.md': 'short' })
    const { agent, tasks } = fakeAgent()
    const run = () => digestRepoFiles({ ...base, agent, dir, kv: kv as NonNullable<typeof kv> })
    const first = await run()
    expect(first.find((r) => r.file === 'CONTRIBUTING.md')?.outcome).toBe('digested')
    expect(first.find((r) => r.file === 'AGENTS.md')?.outcome).toBe('short')
    expect(first.find((r) => r.file === 'REVIEW.md')?.outcome).toBe('missing')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.tier).toBe('fast')
    expect(tasks[0]?.capabilities).toEqual([])
    const stored = await readRepoDigests({
      kv: kv as NonNullable<typeof kv>,
      ...base,
      files: ['CONTRIBUTING.md'],
    })
    expect(stored.get('CONTRIBUTING.md')?.groups.general[0]?.text).toBe('Run make test.')

    expect((await run()).find((r) => r.file === 'CONTRIBUTING.md')?.outcome).toBe('unchanged')
    expect(tasks).toHaveLength(1)

    await writeFile(join(dir, 'CONTRIBUTING.md'), `${doc}\nMore.`)
    expect((await run()).find((r) => r.file === 'CONTRIBUTING.md')?.outcome).toBe('digested')
    expect(tasks).toHaveLength(2)
  })

  test('a failing call is reported and stores nothing', async () => {
    const { kv } = memoryStore()
    const dir = await checkout({ 'CONTRIBUTING.md': doc })
    const { agent } = fakeAgent(undefined, new Error('boom'))
    const out = await digestRepoFiles({
      ...base,
      agent,
      dir,
      kv: kv as NonNullable<typeof kv>,
      files: ['CONTRIBUTING.md'],
    })
    expect(out[0]).toMatchObject({ outcome: 'failed', reason: 'boom' })
    expect(await kv?.get(digestKey('work', 'acme/web', 'CONTRIBUTING.md'))).toBeUndefined()
  })

  test('a budget refusal ends the run', async () => {
    const { kv } = memoryStore()
    const dir = await checkout({ 'CONTRIBUTING.md': doc })
    const { agent } = fakeAgent(undefined, new BudgetExceededError('weekly budget'))
    const error = await digestRepoFiles({
      ...base,
      agent,
      dir,
      kv: kv as NonNullable<typeof kv>,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BudgetExceededError)
  })

  test('the test document is long enough to be digested', () => {
    expect(doc.length).toBeGreaterThan(DIGEST_MIN_CHARS)
  })
})
