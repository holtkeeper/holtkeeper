import { describe, expect, test } from 'bun:test'

import { cosine } from '@holtkeeper/embed'
import { createFakeEmbedder } from '@holtkeeper/embed/testing'

import { entry, repo } from '../test/entries.ts'
import { embeddingText } from './embeddings.ts'
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
    expect(matchesTask(entry({ scope: { teams: ['games'] } }), task)).toBeTrue()
    expect(matchesTask(entry({ scope: { teams: ['tools'] } }), task)).toBeFalse()
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

describe('matchesTask with match', () => {
  const web = repo('acme/round/web', ['widgets'])
  const familyEntry = entry({ match: { families: ['f-web', 'f-app'] } })
  const filesEntry = entry({ match: { files: ['src/**/*.test.ts', 'e2e/**'] } })
  const task = (files?: string[]) => ({ kind: 'review', repo: web, ...(files && { files }) })

  test('match.families needs the task family among them', () => {
    expect(matchesTask(familyEntry, { kind: 'review', repo: web, family: 'f-web' })).toBeTrue()
    expect(matchesTask(familyEntry, { kind: 'review', repo: web, family: 'f-api' })).toBeFalse()
    expect(matchesTask(familyEntry, { kind: 'review', repo: web })).toBeFalse()
  })

  test('match.files needs one touched file to match, only when the files are known', () => {
    expect(matchesTask(filesEntry, task(['README.md', 'src/widget/knob.test.ts']))).toBeTrue()
    expect(matchesTask(filesEntry, task(['./e2e/login.spec.ts']))).toBeTrue()
    expect(matchesTask(filesEntry, task(['src/widget/knob.ts']))).toBeFalse()
    expect(matchesTask(filesEntry, task([]))).toBeFalse()
    expect(matchesTask(filesEntry, task())).toBeTrue()
  })

  test('both parts must hold; empty lists narrow nothing', () => {
    const both = entry({ match: { families: ['f-web'], files: ['src/**'] } })
    expect(
      matchesTask(both, { kind: 'review', repo: web, family: 'f-web', files: ['src/a.ts'] }),
    ).toBeTrue()
    expect(
      matchesTask(both, { kind: 'review', repo: web, family: 'f-web', files: ['docs/a.md'] }),
    ).toBeFalse()
    expect(
      matchesTask(entry({ match: { families: [], files: [] } }), { kind: 'review', repo: web }),
    ).toBeTrue()
  })

  test('the scope still bounds a matching family', () => {
    const elsewhere = entry({ scope: { teams: ['gizmo'] }, match: { families: ['f-web'] } })
    expect(matchesTask(elsewhere, { kind: 'review', repo: web, family: 'f-web' })).toBeFalse()
  })
})

describe('selectForTask', () => {
  test('ranks by scope specificity, then relevance, then recency', () => {
    const entries = [
      entry({ id: 'global', title: 'Vitest everywhere', updatedAt: '2026-10-05T00:00:00.000Z' }),
      entry({ id: 'team', scope: { teams: ['games'] }, title: 'Games use Pixi' }),
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
      'team',
      'global-hit',
      'global',
      'global-old',
    ])
    expect(result.selected[3]?.score).toBeGreaterThan(0)
    expect(result.omitted).toEqual([])
  })

  test('a deeper folder ranks above a shallower one, both above teams', () => {
    const web = repo('acme/round/web', ['widgets'])
    const result = selectForTask({
      entries: [
        entry({ id: 'team', scope: { teams: ['widgets'] }, title: 'Team rule' }),
        entry({ id: 'other-team', scope: { teams: ['gizmo'] }, title: 'Other team rule' }),
        entry({ id: 'acme', scope: { repos: ['work:acme/**'] }, title: 'Acme rule' }),
        entry({ id: 'round', scope: { repos: ['work:acme/round/**'] }, title: 'Round rule' }),
        entry({ id: 'shape', scope: { repos: ['work:acme/*/web'] }, title: 'Shape rule' }),
        entry({ id: 'global', title: 'Global rule' }),
      ],
      task: { kind: 'review', repo: web },
      budgetTokens: 10_000,
    })
    expect(result.selected.map((s) => s.entry.id)).toEqual([
      'round',
      'acme',
      'shape',
      'team',
      'global',
    ])
  })

  test('among equally specific scopes an entry narrowed by match comes first', () => {
    const web = repo('acme/round/web', ['widgets'])
    const result = selectForTask({
      entries: [
        entry({ id: 'plain', scope: { teams: ['widgets'] }, title: 'Plain rule' }),
        entry({
          id: 'family',
          scope: { teams: ['widgets'] },
          match: { families: ['f-web'] },
          title: 'Family rule',
          updatedAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
      task: { kind: 'review', repo: web, family: 'f-web' },
      budgetTokens: 10_000,
    })
    expect(result.selected.map((s) => s.entry.id)).toEqual(['family', 'plain'])
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
      scope: { teams: ['games'] },
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

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`

describe('selectForTask with semantic', () => {
  const same = [
    entry({ id: 'title-hit', title: 'Snapshot rules', body: 'Keep them small.', updatedAt: at(1) }),
    entry({ id: 'body-hit', title: 'Fixtures', body: 'No snapshot files.', updatedAt: at(2) }),
    entry({ id: 'no-hit', title: 'Fixtures layout', body: 'One folder.', updatedAt: at(3) }),
  ]
  const task = { kind: 'review', repo: app, query: 'snapshot' }

  test('relevance becomes the fusion of the text and the vector ranking', () => {
    const lexical = selectForTask({ entries: same, task, budgetTokens: 10_000 })
    expect(lexical.selected.map((s) => s.entry.id)).toEqual(['title-hit', 'body-hit', 'no-hit'])

    const semantic = new Map([
      ['body-hit', 0.9],
      ['no-hit', 0.8],
      ['title-hit', 0.1],
    ])
    const fused = selectForTask({ entries: same, task, budgetTokens: 10_000, semantic })
    expect(fused.selected.map((s) => [s.entry.id, s.score])).toEqual([
      ['body-hit', 1 / 62 + 1 / 61],
      ['title-hit', 1 / 61 + 1 / 63],
      ['no-hit', 1 / 62],
    ])
  })

  test('entries without a vector rank last among the vectors; recency breaks ties', () => {
    const result = selectForTask({
      entries: same,
      task: { kind: 'review', repo: app },
      budgetTokens: 10_000,
      semantic: new Map([['title-hit', 0.5]]),
    })
    expect(result.selected.map((s) => [s.entry.id, s.score])).toEqual([
      ['title-hit', 1 / 61],
      ['no-hit', 0],
      ['body-hit', 0],
    ])
  })

  test('specificity still comes first and vectors never make an entry apply', () => {
    const result = selectForTask({
      entries: [
        ...same,
        entry({ id: 'exact', scope: { repos: ['work:games/app'] }, title: 'App rule' }),
        entry({ id: 'other-team', scope: { teams: ['tools'] }, title: 'Snapshot everything' }),
        entry({ id: 'draft', status: 'proposed', title: 'Snapshot drafts' }),
      ],
      task,
      budgetTokens: 10_000,
      semantic: new Map([
        ['other-team', 1],
        ['draft', 1],
        ['body-hit', 0.9],
      ]),
    })
    expect(result.selected.map((s) => s.entry.id)).toEqual([
      'exact',
      'body-hit',
      'title-hit',
      'no-hit',
    ])
  })

  test('with the fake embedder, the entry closest in meaning to the task wins among equals', async () => {
    const embedder = createFakeEmbedder()
    const entries = [
      entry({
        id: 'colors',
        title: 'Widget colors',
        body: 'Take widget colors from the palette tokens.',
        topics: ['styles'],
      }),
      entry({
        id: 'radius',
        title: 'Card corners',
        body: 'Rounded corners on every widget card use the radius token.',
        topics: ['styles'],
      }),
      entry({
        id: 'tests',
        title: 'Card tests',
        body: 'Every widget card has a render test.',
        topics: ['testing'],
      }),
    ]
    const query = 'Round the corners of the widget card with the radius token'
    const { vectors } = await embedder.embed(entries.map(embeddingText), 'document')
    const {
      vectors: [queryVector],
    } = await embedder.embed([query], 'query')
    const semantic = new Map(entries.map((e, i) => [e.id, cosine(vectors[i]!, queryVector!)]))
    const result = selectForTask({
      entries,
      task: { kind: 'review', repo: app, query },
      budgetTokens: 10_000,
      semantic,
    })
    expect(semantic.get('radius')).toBeGreaterThan(
      Math.max(semantic.get('colors')!, semantic.get('tests')!),
    )
    expect(result.selected[0]?.entry.id).toBe('radius')
    expect(result.selected[0]?.score).toBeCloseTo(2 / 61, 12)
  })
})
