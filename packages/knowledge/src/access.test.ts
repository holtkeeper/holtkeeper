import { beforeEach, describe, expect, test } from 'bun:test'

import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { entry, repo } from '../test/entries.ts'
import { knowledgeAccess } from './access.ts'

const now = () => new Date('2026-10-30T12:00:00.000Z')
const slots = repo('games/slots', ['games'])

let store: Store
beforeEach(async () => {
  store = memoryStore()
  for (const item of [
    entry({ id: 'global', title: 'Snapshot tests are banned', body: 'Use assertions.' }),
    entry({
      id: 'games',
      scope: { groups: ['games'] },
      title: 'Snapshot fixtures',
      body: 'Small.',
    }),
    entry({ id: 'tools', scope: { groups: ['tools'] }, title: 'Snapshot tools', body: 'x' }),
    entry({ id: 'tests-only', appliesTo: ['tests'], title: 'Snapshot naming', body: 'x' }),
    entry({ id: 'draft', status: 'proposed', title: 'Snapshot draft', body: 'x' }),
    entry({ id: 'other', title: 'Translations', body: 'ICU.' }),
  ])
    await store.knowledge.put(item)
})

describe('knowledgeAccess', () => {
  test('search returns accepted entries for the repository and task kind', async () => {
    const kb = knowledgeAccess({ store, now })
    const results = await kb.search('snapshot', { repo: slots, taskKind: 'review' })
    expect(results.map((r) => r.id)).toEqual(['games', 'global'])
    expect(results[1]).toEqual({
      id: 'global',
      title: 'Snapshot tests are banned',
      kind: 'convention',
      body: 'Use assertions.',
      score: expect.any(Number),
    })
    expect(
      (await kb.search('snapshot', { repo: slots, taskKind: 'tests', limit: 1 })).map((r) => r.id),
    ).toHaveLength(1)
    expect(await kb.search('"((', { repo: slots, taskKind: 'review' })).toEqual([])
  })

  test('a blank query lists applicable entries, most specific first', async () => {
    const kb = knowledgeAccess({ store, now })
    const results = await kb.search('', { repo: slots, taskKind: 'review', limit: 10 })
    expect(results[0]?.id).toBe('games')
    expect(results.map((r) => r.id).toSorted()).toEqual(['games', 'global', 'other'])
  })

  test('propose creates, dedupes and auto-accepts', async () => {
    const kb = knowledgeAccess({ store, now, autoAccept: ['quirk'] })
    const ctx = {
      actor: 'agent:propagate',
      repo: slots,
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
})
