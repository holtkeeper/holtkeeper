import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import type { Learning, SettingEntry } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  createRulesResolver,
  learningPolicyFor,
  readForgeRuleFiles,
  settleLearnings,
} from '../src/rules.ts'

const now = () => new Date('2026-11-10T10:00:00.000Z')

const files: Record<string, string> = {
  'AGENTS.md': 'Gadgets use the shared logger.',
  'pkg/sprockets/AGENTS.md': 'Sprockets are immutable.',
  'node_modules/some-lib/AGENTS.md': 'Never read this.',
  'src/index.ts': 'export {}',
}

function fakeForge(head: string | undefined) {
  const reads: string[] = []
  return {
    reads,
    forge: {
      headCommit: async () => head,
      listFiles: async () => Object.keys(files).map((path) => ({ path, type: 'file' as const })),
      readFile: async (_repo: string, path: string) => {
        reads.push(path)
        return files[path]
      },
    },
  }
}

const config = parseConfig({
  forges: {
    work: { kind: 'fake', url: 'https://forge.test', create: () => fakeForge('h1').forge as never },
  },
  teams: { gadgets: { owns: ['work:gadgets/*'] } },
})

const setting = (key: string, value: unknown, scope: SettingEntry['scope']): SettingEntry => ({
  id: `${key}:${JSON.stringify(scope)}`,
  key,
  scope,
  value,
  secret: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const learning = (id: string, overrides: Partial<Learning> = {}): Learning => ({
  id,
  text: `Rule ${id}.`,
  key: `rule ${id}`,
  scope: { repos: ['work:gadgets/app'] },
  origin: 'reply',
  status: 'pending',
  sources: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  activeAt: '2026-11-04T00:00:00.000Z',
  lastReinforcedAt: '2026-11-01T00:00:00.000Z',
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  ...overrides,
})

describe('readForgeRuleFiles', () => {
  test('reads nested rules files once per head and skips vendored ones', async () => {
    const store = memoryStore()
    const { forge, reads } = fakeForge('h1')
    const read = () =>
      readForgeRuleFiles({ forge, forgeId: 'work', repo: 'gadgets/app', kv: store.kv! })
    const first = await read()
    expect(first.map((file) => [file.path, file.kind])).toEqual([
      ['AGENTS.md', 'always'],
      ['pkg/sprockets/AGENTS.md', 'files'],
    ])
    await read()
    expect(reads).toEqual(['AGENTS.md', 'pkg/sprockets/AGENTS.md'])
  })
})

describe('learning policy', () => {
  test('the repository entry wins; without a repository the global one', () => {
    const entries = [
      setting('learnings.approvalDelayDays', 7, { all: true }),
      setting('learnings.approvalDelayDays', 0, { teams: ['gadgets'] }),
      setting('learnings.expiryDays', 30, { all: true }),
    ]
    expect(learningPolicyFor(entries)).toEqual({ approvalDelayDays: 7, expiryDays: 30 })
    expect(
      learningPolicyFor(entries, { forge: 'work', path: 'gadgets/app', teams: ['gadgets'] }),
    ).toEqual({ approvalDelayDays: 0, expiryDays: 30 })
    expect(learningPolicyFor([])).toEqual({ approvalDelayDays: 3, expiryDays: 90 })
  })

  test('the leader tick activates due learnings and expires stale ones', async () => {
    const store = memoryStore()
    await store.learnings.put(learning('due'))
    await store.learnings.put(learning('later', { activeAt: '2026-11-12T00:00:00.000Z' }))
    await store.learnings.put(
      learning('stale', { status: 'active', lastReinforcedAt: '2026-07-01T00:00:00.000Z' }),
    )
    expect(await settleLearnings({ store, config, now })).toBe(2)
    expect((await store.learnings.get('due'))?.status).toBe('active')
    expect((await store.learnings.get('later'))?.status).toBe('pending')
    expect((await store.learnings.get('stale'))?.status).toBe('expired')
    expect(await settleLearnings({ store, config, now })).toBe(0)
  })
})

describe('createRulesResolver', () => {
  test('combines panel rules, forge rules files, policies and due learnings', async () => {
    const store = memoryStore()
    await store.rules.put({
      id: 'r1',
      title: 'Logging',
      body: 'Log through the gadget logger.',
      scope: { teams: ['gadgets'] },
      author: 'u1',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    await store.learnings.put(learning('due'))
    const resolve = createRulesResolver({ store, config, now })
    const resolved = await resolve({
      repo: { forge: 'work', path: 'gadgets/app', teams: ['gadgets'] },
      agent: 'task',
      files: ['src/index.ts'],
    })
    expect(resolved.text).toContain('### Logging [rule:r1]')
    expect(resolved.text).toContain('Gadgets use the shared logger.')
    expect(resolved.text).not.toContain('Sprockets are immutable.')
    expect(resolved.text).toContain('[learn:due]')
    const given = await resolve({
      repo: { forge: 'work', path: 'gadgets/app', teams: ['gadgets'] },
      agent: 'review',
      repoFiles: [],
    })
    expect(given.text).not.toContain('Gadgets use the shared logger.')
  })
})
