import { beforeEach, describe, expect, test } from 'bun:test'

import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { entry, repo } from '../test/entries.ts'
import { knowledgeAccess } from './access.ts'

const now = () => new Date('2026-10-30T12:00:00.000Z')
const app = repo('games/app', ['games'])

let store: Store
beforeEach(async () => {
  store = memoryStore()
  for (const item of [
    entry({ id: 'global', title: 'Snapshot tests are banned', body: 'Use assertions.' }),
    entry({
      id: 'games',
      scope: { teams: ['games'] },
      title: 'Snapshot fixtures',
      body: 'Small.',
    }),
    entry({ id: 'tools', scope: { teams: ['tools'] }, title: 'Snapshot tools', body: 'x' }),
    entry({ id: 'tests-only', appliesTo: ['tests'], title: 'Snapshot naming', body: 'x' }),
    entry({ id: 'draft', status: 'proposed', title: 'Snapshot draft', body: 'x' }),
    entry({ id: 'other', title: 'Translations', body: 'ICU.' }),
  ])
    await store.knowledge.put(item)
})

describe('knowledgeAccess', () => {
  test('search returns accepted entries for the repository and task kind', async () => {
    const kb = knowledgeAccess({ store, now })
    const results = await kb.search('snapshot', { repo: app, taskKind: 'review' })
    expect(results.map((r) => r.id)).toEqual(['games', 'global'])
    expect(results[1]).toEqual({
      id: 'global',
      title: 'Snapshot tests are banned',
      kind: 'convention',
      body: 'Use assertions.',
      score: expect.any(Number),
    })
    expect(
      (await kb.search('snapshot', { repo: app, taskKind: 'tests', limit: 1 })).map((r) => r.id),
    ).toHaveLength(1)
    expect(await kb.search('"((', { repo: app, taskKind: 'review' })).toEqual([])
  })

  test('a blank query lists applicable entries, most specific first', async () => {
    const kb = knowledgeAccess({ store, now })
    const results = await kb.search('', { repo: app, taskKind: 'review', limit: 10 })
    expect(results[0]?.id).toBe('games')
    expect(results.map((r) => r.id).toSorted()).toEqual(['games', 'global', 'other'])
  })

  test('a blank query lists a folder entry before a team entry', async () => {
    await store.knowledge.put(
      entry({ id: 'arcade', scope: { repos: ['work:games/**'] }, title: 'Arcade', body: 'x' }),
    )
    const kb = knowledgeAccess({ store, now })
    const results = await kb.search('', { repo: app, taskKind: 'review', limit: 10 })
    expect(results.map((r) => r.id).slice(0, 2)).toEqual(['arcade', 'games'])
    expect(
      (
        await kb.search('', { repo: repo('tools/app', ['tools']), taskKind: 'review', limit: 10 })
      ).map((r) => r.id),
    ).not.toContain('arcade')
  })

  test('entries narrowed to families need the repository family', async () => {
    await store.knowledge.put(
      entry({
        id: 'family',
        scope: { teams: ['games'] },
        match: { families: ['f-web'] },
        title: 'Snapshot family rule',
        body: 'x',
      }),
    )
    await store.knowledge.put(
      entry({
        id: 'files',
        scope: { teams: ['games'] },
        match: { files: ['src/**'] },
        title: 'Snapshot files rule',
        body: 'x',
      }),
    )
    const kb = knowledgeAccess({ store, now })
    const ids = async (target: typeof app & { family?: string }) =>
      (await kb.search('snapshot', { repo: target, taskKind: 'review', limit: 10 })).map(
        (r) => r.id,
      )
    expect(await ids({ ...app, family: 'f-web' })).toContain('family')
    expect(await ids({ ...app, family: 'f-api' })).not.toContain('family')
    expect(await ids(app)).not.toContain('family')
    expect(await ids(app)).toContain('files')
  })

  test('semantic finds entries close in meaning and fuses the rankings', async () => {
    const asked: string[] = []
    const kb = knowledgeAccess({
      store,
      now,
      semantic: async (query) => {
        asked.push(query)
        return new Map([
          ['global', 0.8],
          ['other', 0.1],
          ['tools', 0.9],
        ])
      },
    })
    // No shared word: the full-text search finds nothing, the vectors find `global` (the
    // `tools` entry is another team's, `other` is not close enough).
    const found = await kb.search('border radius', { repo: app, taskKind: 'review' })
    expect(found.map((r) => [r.id, r.score])).toEqual([['global', 1 / 61]])
    // `games` and `global` both match the words; only `global` has a vector, so it comes first.
    expect(
      (await kb.search('snapshot', { repo: app, taskKind: 'review' })).map((r) => r.id),
    ).toEqual(['global', 'games'])
    expect(await kb.search('', { repo: app, taskKind: 'review', limit: 1 })).toHaveLength(1)
    expect(asked).toEqual(['border radius', 'snapshot'])
  })

  test('without vectors, or when they fail, search stays full text', async () => {
    const off = knowledgeAccess({ store, now, semantic: async () => undefined })
    const failing = knowledgeAccess({
      store,
      now,
      semantic: () => Promise.reject(new Error('gateway down')),
    })
    const results = await Promise.all(
      [off, failing].map((kb) => kb.search('snapshot', { repo: app, taskKind: 'review' })),
    )
    expect(results.map((found) => found.map((r) => r.id))).toEqual([
      ['games', 'global'],
      ['games', 'global'],
    ])
  })

  test('propose dedupes by meaning with proposalSimilarity', async () => {
    const proposals: string[] = []
    const kb = knowledgeAccess({
      store,
      now,
      proposalSimilarity: async (proposal) => {
        proposals.push(proposal.title)
        return (candidate) => (candidate.id === 'global' ? 0.95 : 0.2)
      },
    })
    const result = await kb.propose(
      { title: 'Assert, do not snapshot', body: 'Prefer explicit expectations.' },
      { actor: 'agent:review', repo: app, taskKind: 'review' },
    )
    expect(result).toEqual({ id: 'global', status: 'accepted', duplicateOf: 'global' })
    expect(proposals).toEqual(['Assert, do not snapshot'])
  })

  test('propose creates, dedupes and auto-accepts', async () => {
    const kb = knowledgeAccess({ store, now, autoAccept: ['quirk'] })
    const ctx = {
      actor: 'agent:propagate',
      repo: app,
      taskKind: 'propagate',
      packages: [{ ecosystem: 'npm', name: 'react', from: '18.3.1', to: '19.0.0' }],
    }
    const created = await kb.propose(
      { title: 'React 19 drops propTypes', body: 'Remove propTypes from react components.' },
      ctx,
    )
    expect(created).toEqual({ id: expect.any(String), status: 'proposed' })
    expect((await store.knowledge.get(created.id))?.kind).toBe('migration')

    const duplicate = await kb.propose(
      { title: 'React 19 drops propTypes', body: 'Same thing.' },
      ctx,
    )
    expect(duplicate).toEqual({ id: created.id, status: 'proposed', duplicateOf: created.id })

    const quirk = await kb.propose(
      {
        title: 'Flaky storybook build',
        body: 'Workaround: clear the cache.',
        scope: { all: true },
      },
      ctx,
    )
    expect(quirk.status).toBe('accepted')
    expect((await store.knowledge.get(quirk.id))?.scope).toEqual({ all: true })
  })

  test('autoAccept may depend on the proposing repository', async () => {
    const seen: string[] = []
    const kb = knowledgeAccess({
      store,
      now,
      autoAccept: (target) => {
        seen.push(target.path)
        return target.teams.includes('games') ? ['howto'] : []
      },
    })
    const proposal = {
      title: 'Run the asset build first',
      body: 'How to: run assets before tests.',
    }
    const ctx = { actor: 'agent:tests', taskKind: 'tests' }
    const inGames = await kb.propose(proposal, { ...ctx, repo: app })
    const elsewhere = await kb.propose(
      { title: 'Regenerate the client', body: 'How to: run codegen after schema edits.' },
      { ...ctx, repo: { forge: 'work', path: 'tools/cli', teams: [] } },
    )
    expect(inGames.status).toBe('accepted')
    expect(elsewhere.status).toBe('proposed')
    expect(seen).toEqual([app.path, 'tools/cli'])
  })
})
