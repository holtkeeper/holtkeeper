import { beforeEach, describe, expect, test } from 'bun:test'

import type { Store } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import { entry, repo } from '../test/entries.ts'
import { mergeEvidence, packageSubject, proposeEntry, sharingDefaults } from './propose.ts'
import { KnowledgeValidationError } from './schema.ts'

const now = () => new Date('2026-10-30T12:00:00.000Z')
const app = repo('games/app', ['games'])
const reactTask = {
  kind: 'propagate',
  repo: app,
  packages: [{ ecosystem: 'npm', name: 'react', from: '18.3.1', to: '19.0.0' }],
}

let store: Store
beforeEach(() => {
  store = memoryStore()
})

describe('proposeEntry', () => {
  test('stores a classified proposed agent entry scoped to the repository', async () => {
    const result = await proposeEntry({
      store,
      input: {
        title: 'useRef needs an argument',
        body: 'React 19 types require `useRef(undefined)`.',
        evidence: [{ label: 'MR !12', url: 'https://forge.test/mr/12' }],
      },
      actor: 'agent:propagate',
      task: reactTask,
      now,
    })
    expect(result.created).toBeTrue()
    expect(result.duplicateOf).toBeUndefined()
    expect(result.entry).toMatchObject({
      kind: 'migration',
      status: 'proposed',
      source: 'agent',
      author: 'agent:propagate',
      scope: { repos: ['work:games/app'] },
      packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19', to: '>=19 <20' }],
      appliesTo: ['propagate', 'port', 'review'],
      createdAt: '2026-10-30T12:00:00.000Z',
      version: 1,
    })
    expect(await store.knowledge.get(result.entry.id)).toEqual(result.entry)
    expect((await store.audit.list()).events.map((e) => [e.action, e.target])).toEqual([
      ['knowledge.propose', { type: 'knowledge', id: result.entry.id, repo: 'work:games/app' }],
    ])
  })

  test('auto-accepts configured kinds', async () => {
    const result = await proposeEntry({
      store,
      input: { title: 'Flaky e2e on CI', body: 'Workaround: retry once.' },
      actor: 'agent:review',
      task: { kind: 'review', repo: app },
      now,
      autoAccept: ['quirk'],
    })
    expect(result.entry).toMatchObject({ kind: 'quirk', status: 'accepted', appliesTo: ['*'] })
    expect((await store.audit.list()).events[0]?.action).toBe('knowledge.accept')
  })

  test('returns the existing entry for duplicates and merges new evidence', async () => {
    const existing = await store.knowledge.put(
      entry({
        id: 'vitest',
        title: 'Prefer Vitest over Jest',
        body: 'All new unit tests use Vitest; Jest is being phased out across packages.',
        evidence: [{ label: 'MR !1', url: 'https://forge.test/mr/1' }],
      }),
    )
    const same = async (title: string, body: string, url?: string) =>
      proposeEntry({
        store,
        input: { title, body, ...(url && { evidence: [{ label: 'MR', url }] }) },
        actor: 'agent:review',
        task: { kind: 'review', repo: app },
        now,
      })

    const byTitle = await same('prefer vitest  over JEST!', 'Different words entirely here.')
    expect(byTitle).toMatchObject({ created: false, duplicateOf: 'vitest' })
    expect(byTitle.entry.version).toBe(existing.version)

    const byOverlap = await same(
      'Prefer Vitest to Jest',
      'All new unit tests use Vitest; Jest is being phased out across all packages.',
      'https://forge.test/mr/7',
    )
    expect(byOverlap).toMatchObject({ created: false, duplicateOf: 'vitest' })
    expect(byOverlap.entry.evidence.map((link) => link.url)).toEqual([
      'https://forge.test/mr/1',
      'https://forge.test/mr/7',
    ])
    expect(byOverlap.entry).toMatchObject({ version: 2, updatedBy: 'agent:review' })

    const again = await same('Prefer Vitest over Jest', 'x', 'https://forge.test/mr/7')
    expect(again.entry.version).toBe(2)
    expect(await store.knowledge.list()).toHaveLength(1)
    expect((await store.audit.list()).events.map((e) => e.action)).toEqual(['knowledge.evidence'])

    const different = await same('Snapshot tests are banned', 'Use explicit assertions.')
    expect(different.created).toBeTrue()
  })

  test('the superseded entry is not a duplicate, every other entry still is', async () => {
    await store.knowledge.put(
      entry({
        id: 'narrow',
        title: 'Run generators through make gen',
        body: 'Mocks come from make gen.',
        scope: { repos: ['work:games/app'] },
      }),
    )
    await store.knowledge.put(
      entry({ id: 'other', title: 'Format with gofmt', body: 'Run gofmt before pushing.' }),
    )
    const promoted = await proposeEntry({
      store,
      input: {
        title: 'Run generators through make gen',
        body: 'Mocks come from make gen in every service.',
        scope: { groups: ['games'] },
        supersedes: 'narrow',
      },
      actor: 'agent:knowledge-bootstrap',
      task: { repo: app },
      now,
    })
    expect(promoted.created).toBeTrue()
    expect(promoted.entry).toMatchObject({
      status: 'proposed',
      supersedes: 'narrow',
      scope: { groups: ['games'] },
    })
    const blocked = await proposeEntry({
      store,
      input: { title: 'Format with gofmt', body: 'x', supersedes: 'narrow' },
      actor: 'agent:knowledge-bootstrap',
      task: { repo: app },
      now,
    })
    expect(blocked).toMatchObject({ created: false, duplicateOf: 'other' })
  })

  test('notDuplicates and duplicateScope narrow what counts as a duplicate', async () => {
    await store.knowledge.put(
      entry({
        id: 'sibling-a',
        title: 'Run generators through make gen',
        scope: { repos: ['games/a'] },
      }),
    )
    await store.knowledge.put(
      entry({
        id: 'sibling-b',
        title: 'Run generators through make gen',
        scope: { repos: ['games/b'] },
      }),
    )
    const input = {
      title: 'Run generators through make gen',
      body: 'Every service of the team generates code with make gen.',
      scope: { groups: ['games'] },
      supersedes: 'sibling-a',
    }
    const swallowed = await proposeEntry({
      store,
      input,
      actor: 'agent:x',
      task: { repo: app },
      now,
    })
    expect(swallowed).toMatchObject({ created: false, duplicateOf: 'sibling-b' })

    const promoted = await proposeEntry({
      store,
      input,
      actor: 'agent:x',
      task: { repo: app },
      now,
      notDuplicates: ['sibling-a', 'sibling-b'],
    })
    expect(promoted.created).toBeTrue()

    const elsewhere = await proposeEntry({
      store,
      input: { title: 'Run generators through make gen', body: 'Other team.' },
      actor: 'agent:x',
      task: { repo: repo('tools/kit', ['tools']) },
      now,
      duplicateScope: (candidate) => candidate.scope.groups?.includes('tools') ?? false,
    })
    expect(elsewhere.created).toBeTrue()
    expect(elsewhere.entry.scope).toEqual({ repos: ['work:tools/kit'] })
  })

  test('archived entries do not block a new proposal', async () => {
    await store.knowledge.put(entry({ id: 'gone', title: 'Old rule', status: 'archived' }))
    const result = await proposeEntry({
      store,
      input: { title: 'Old rule', body: 'Back again.' },
      actor: 'agent:review',
      task: { kind: 'review', repo: app },
      now,
    })
    expect(result.created).toBeTrue()
  })

  test('rejects proposals that break the rules', async () => {
    const attempt = proposeEntry({
      store,
      input: { title: 'No scope', body: 'Proposed outside any repository.' },
      actor: 'agent:review',
      now,
    })
    const error = await attempt.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(KnowledgeValidationError)
    expect(error instanceof KnowledgeValidationError ? error.issues : []).toEqual([
      'scope: scope must not be empty',
    ])
    const migration = await proposeEntry({
      store,
      input: { title: 'Upgrade', body: 'Notes.', kind: 'migration' },
      actor: 'agent:port',
      task: { kind: 'port', repo: app },
      now,
    }).catch((caught: unknown) => caught)
    expect(String(migration)).toContain('packages: a migration must name its packages')
    expect(await store.knowledge.list()).toEqual([])
  })
})

describe('mergeEvidence', () => {
  test('adds only new links, keeps the text and audits the addition', async () => {
    const stored = await store.knowledge.put(
      entry({
        id: 'e1',
        status: 'proposed',
        evidence: [{ label: 'MR !1', url: 'https://forge.test/mr/1' }],
      }),
    )
    const nothing = await mergeEvidence({
      store,
      entry: stored,
      evidence: [{ label: 'again', url: 'https://forge.test/mr/1' }],
      actor: 'agent:knowledge-bootstrap',
      now,
    })
    expect(nothing).toEqual({ entry: stored, added: [] })
    const merged = await mergeEvidence({
      store,
      entry: stored,
      evidence: [
        { label: 'MR !2', url: 'https://forge.test/mr/2' },
        { label: 'MR !2 twice', url: 'https://forge.test/mr/2' },
      ],
      actor: 'agent:knowledge-bootstrap',
      repo: 'work:games/app',
      now,
    })
    expect(merged.added).toEqual([{ label: 'MR !2', url: 'https://forge.test/mr/2' }])
    expect(merged.entry).toMatchObject({
      title: stored.title,
      status: 'proposed',
      version: 2,
      updatedBy: 'agent:knowledge-bootstrap',
    })
    expect(merged.entry.evidence.map((link) => link.url)).toEqual([
      'https://forge.test/mr/1',
      'https://forge.test/mr/2',
    ])
    expect((await store.audit.list()).events.map((e) => [e.action, e.target])).toEqual([
      ['knowledge.evidence', { type: 'knowledge', id: 'e1', repo: 'work:games/app' }],
    ])
  })
})

describe('sharingDefaults', () => {
  test('a decision about one package is shared with that package as subject', () => {
    expect(
      sharingDefaults({ kind: 'decision', packages: [{ ecosystem: 'npm', name: 'widget-kit' }] }),
    ).toEqual({ subject: 'npm:widget-kit', visibility: 'shared' })
    expect(
      sharingDefaults({
        kind: 'convention',
        packages: [{ ecosystem: 'go', name: 'example.com/kit' }],
      }),
    ).toEqual({ subject: 'Go:example.com/kit', visibility: 'shared' })
  })

  test('other kinds, several packages and explicit choices stay as they are', () => {
    expect(
      sharingDefaults({ kind: 'quirk', packages: [{ ecosystem: 'npm', name: 'widget-kit' }] }),
    ).toEqual({ subject: 'npm:widget-kit' })
    expect(
      sharingDefaults({
        kind: 'decision',
        packages: [
          { ecosystem: 'npm', name: 'a' },
          { ecosystem: 'npm', name: 'b' },
        ],
      }),
    ).toEqual({})
    expect(sharingDefaults({ kind: 'decision', subject: 'tool:node', visibility: 'team' })).toEqual(
      { subject: 'tool:node', visibility: 'team' },
    )
  })

  test('agent decisions about a package are proposed as shared', async () => {
    const result = await proposeEntry({
      store,
      input: {
        title: 'Use widget-kit for forms',
        body: 'We decided to use widget-kit instead of hand-written forms.',
        kind: 'decision',
        packages: [{ ecosystem: 'npm', name: 'widget-kit' }],
      },
      actor: 'agent:review',
      task: { kind: 'review', repo: app },
      now,
    })
    expect(result.entry).toMatchObject({ visibility: 'shared', subject: 'npm:widget-kit' })
    expect(packageSubject({ ecosystem: 'npm', name: 'widget-kit' })).toBe('npm:widget-kit')
  })
})
