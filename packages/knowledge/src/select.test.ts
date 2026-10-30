import { describe, expect, test } from 'bun:test'

import { entry, repo } from '../test/entries.ts'
import { matchesTask, renderEntry, selectForTask } from './select.ts'

const app = repo('games/app', ['games'])
const reactMigration = entry({
  id: 'mig',
  kind: 'migration',
  title: 'React 19 refs',
  body: 'Pass ref as a prop.',
  topics: [],
  packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19', to: '>=19 <20' }],
  appliesTo: ['propagate'],
})

describe('matchesTask', () => {
  const task = { kind: 'review', repo: app }

  test('needs an accepted entry whose scope covers the repository', () => {
    expect(matchesTask(entry(), task)).toBeTrue()
    expect(matchesTask(entry({ status: 'proposed' }), task)).toBeFalse()
    expect(matchesTask(entry({ scope: { groups: ['games'] } }), task)).toBeTrue()
    expect(matchesTask(entry({ scope: { groups: ['tools'] } }), task)).toBeFalse()
    expect(matchesTask(entry({ scope: { repos: ['other:games/**'] } }), task)).toBeFalse()
  })

  test('needs the task kind or * in appliesTo', () => {
    expect(matchesTask(entry({ appliesTo: ['review', 'port'] }), task)).toBeTrue()
    expect(matchesTask(entry({ appliesTo: ['tests'] }), task)).toBeFalse()
  })

  test('migrations need an overlapping task package', () => {
    const propagate = (from: string, to: string) => ({
      kind: 'propagate',
      repo: app,
      packages: [{ ecosystem: 'npm', name: 'react', from, to }],
    })
    expect(matchesTask(reactMigration, propagate('18.3.1', '19.0.0'))).toBeTrue()
    expect(matchesTask(reactMigration, propagate('16.0.0', '17.0.0'))).toBeFalse()
    expect(matchesTask(reactMigration, { kind: 'propagate', repo: app })).toBeFalse()
  })
})

describe('selectForTask', () => {
  test('ranks by scope specificity, then relevance, then recency', () => {
    const entries = [
      entry({ id: 'global', title: 'Vitest everywhere', updatedAt: '2026-10-05T00:00:00.000Z' }),
      entry({ id: 'group', scope: { groups: ['games'] }, title: 'Games use Pixi' }),
      entry({ id: 'glob', scope: { repos: ['games/**'] }, title: 'Glob rule' }),
      entry({ id: 'exact', scope: { repos: ['work:games/app'] }, title: 'App rule' }),
      entry({ id: 'global-old', title: 'Old global', updatedAt: '2026-09-01T00:00:00.000Z' }),
      entry({ id: 'global-hit', title: 'Snapshot rules', body: 'snapshot tests' }),
    ]
    const result = selectForTask({
      entries,
      task: { kind: 'review', repo: app, query: 'snapshot' },
      budgetTokens: 10_000,
    })
    expect(result.selected.map((s) => s.entry.id)).toEqual([
      'exact',
      'glob',
      'group',
      'global-hit',
      'global',
      'global-old',
    ])
    expect(result.selected[3]?.score).toBeGreaterThan(0)
    expect(result.omitted).toEqual([])
  })

  test('includes migrations only for overlapping packages and drops superseded entries', () => {
    const replaced = entry({ id: 'old', title: 'Old refs advice' })
    const replacement = entry({ id: 'new', title: 'New refs advice', supersedes: 'old' })
    const task = {
      kind: 'propagate',
      repo: app,
      packages: [{ ecosystem: 'npm', name: 'react', from: '18.3.1', to: '19.0.0' }],
    }
    const ids = selectForTask({
      entries: [replaced, replacement, reactMigration],
      task,
      budgetTokens: 10_000,
    }).selected.map((s) => s.entry.id)
    expect(ids).toEqual(['mig', 'new'])
    const unrelated = selectForTask({
      entries: [reactMigration],
      task: { ...task, packages: [{ ecosystem: 'npm', name: 'vue', from: '2.0.0', to: '3.0.0' }] },
      budgetTokens: 10_000,
    })
    expect(unrelated).toEqual({ selected: [], omitted: [], markdown: '', tokens: 0 })
  })

  test('renders a citable block within the token budget', () => {
    const small = entry({
      id: 'small',
      title: 'Short',
      body: 'Tiny.',
      scope: { groups: ['games'] },
    })
    const big = entry({
      id: 'big',
      title: 'Long',
      body: 'x'.repeat(2000),
      scope: { repos: ['games/*'] },
    })
    const last = entry({ id: 'last', title: 'Also short', body: 'Fits.' })
    const result = selectForTask({
      entries: [small, big, last],
      task: { kind: 'review', repo: repo('games/a', ['games']) },
      budgetTokens: 120,
    })
    expect(result.selected.map((s) => s.entry.id)).toEqual(['small', 'last'])
    expect(result.omitted.map((s) => s.entry.id)).toEqual(['big'])
    expect(result.tokens).toBeLessThanOrEqual(120)
    expect(result.tokens).toBe(Math.ceil(result.markdown.length / 4))
    expect(result.markdown).toStartWith('## Team knowledge')
    expect(result.markdown).toContain(
      '### [kb:small] Short\n_convention · topics: testing_\n\nTiny.\n',
    )
    expect(result.markdown).toContain('[kb:last]')

    expect(
      selectForTask({ entries: [small], task: { kind: 'review', repo: app }, budgetTokens: 10 })
        .markdown,
    ).toBe('')
  })

  test('renderEntry shows packages', () => {
    expect(renderEntry(reactMigration)).toBe(
      '### [kb:mig] React 19 refs\n_migration · react >=18 <19 → >=19 <20_\n\nPass ref as a prop.\n',
    )
  })
})
