import { describe, expect, test } from 'bun:test'

import { entry, repo } from '../test/entries.ts'
import { NEIGHBOUR_KNOWLEDGE_HEADER, selectNeighbourKnowledge } from './neighbours.ts'

const round = repo('acme/round/web', ['widgets'])
const square = repo('acme/square/web', ['gizmo'])
const oval = repo('acme/oval/web', ['widgets'])
const neighbours = [
  { repo: square, similarity: 0.9, family: 'f-square' },
  { repo: oval, similarity: 0.6 },
]
const roundReview = { kind: 'review', repo: round }
const pick = (
  entries: Parameters<typeof selectNeighbourKnowledge>[0]['entries'],
  extra: Partial<Parameters<typeof selectNeighbourKnowledge>[0]> = {},
) =>
  selectNeighbourKnowledge({ entries, task: roundReview, neighbours, budgetTokens: 2000, ...extra })

describe('selectNeighbourKnowledge', () => {
  test('takes entries written for a neighbour, never ones covering the task repository', () => {
    const forSquare = entry({ id: 'sq', scope: { repos: ['work:acme/square/web'] } })
    const forAll = entry({ id: 'all', scope: { all: true } })
    const forRound = entry({ id: 'own', scope: { repos: ['work:acme/*/web'] } })
    const elsewhere = entry({ id: 'far', scope: { repos: ['work:acme/hex/web'] } })
    const result = pick([forSquare, forAll, forRound, elsewhere])
    expect(result.selected.map((item) => item.entry.id)).toEqual(['sq'])
    expect(result.selected[0]?.neighbour.repo).toEqual(square)
    expect(result.markdown.startsWith(NEIGHBOUR_KNOWLEDGE_HEADER)).toBeTrue()
    expect(result.markdown).toContain('### [kb:sq] Prefer Vitest')
    expect(result.markdown).toContain('_written for acme/square/web (similarity 0.90) · convention')
  })

  test('needs accepted entries for the task kind, no migrations and nothing superseded', () => {
    const scope = { repos: ['work:acme/square/web'] }
    const result = pick([
      entry({ id: 'proposed', scope, status: 'proposed' }),
      entry({ id: 'port', scope, appliesTo: ['port'] }),
      entry({
        id: 'mig',
        scope,
        kind: 'migration',
        packages: [{ ecosystem: 'npm', name: 'react', from: '>=18 <19' }],
      }),
      entry({ id: 'old', scope }),
      entry({ id: 'new', scope: { teams: ['gizmo'] }, supersedes: 'old' }),
    ])
    expect(result.selected.map((item) => item.entry.id)).toEqual(['new'])
  })

  test("match holds for the neighbour's family and the task's files", () => {
    const scope = { repos: ['work:acme/*/web'] }
    const apiReview = {
      kind: 'review',
      repo: repo('acme/round/api', ['widgets']),
      files: ['src/a.ts'],
    }
    const result = pick(
      [
        entry({ id: 'fam', scope, match: { families: ['f-square'] } }),
        entry({ id: 'other-fam', scope, match: { families: ['f-other'] } }),
        entry({ id: 'files', scope, match: { files: ['src/**'] } }),
        entry({ id: 'no-files', scope, match: { files: ['docs/**'] } }),
      ],
      { task: apiReview },
    )
    expect(result.selected.map((item) => item.entry.id).toSorted()).toEqual(['fam', 'files'])
  })

  test('credits the most alike neighbour and ranks by similarity, specificity, then recency', () => {
    const both = entry({ id: 'both', scope: { teams: ['gizmo', 'shapes'] } })
    const result = selectNeighbourKnowledge({
      entries: [
        entry({
          id: 'ovalA',
          scope: { repos: ['work:acme/oval/web'] },
          updatedAt: '2026-10-03T00:00:00.000Z',
        }),
        entry({ id: 'squareA', scope: { repos: ['work:acme/square/web'] } }),
        entry({
          id: 'ovalB',
          scope: { repos: ['work:acme/oval/web'] },
          updatedAt: '2026-10-02T00:00:00.000Z',
        }),
        both,
      ],
      task: { kind: 'review', repo: round },
      neighbours: [...neighbours, { repo: repo('acme/hex/web', ['shapes']), similarity: 0.7 }],
      budgetTokens: 2000,
    })
    expect(result.selected.map((item) => item.entry.id)).toEqual([
      'squareA',
      'both',
      'ovalA',
      'ovalB',
    ])
    expect(result.selected[1]?.neighbour.repo.path).toBe('acme/square/web')
  })

  test('relevance to the query, weighted by similarity, ranks first', () => {
    const result = pick(
      [
        entry({ id: 'sq', scope: { repos: ['work:acme/square/web'] }, title: 'Name test ids' }),
        entry({
          id: 'ov',
          scope: { repos: ['work:acme/oval/web'] },
          title: 'Cache sprite atlases',
        }),
      ],
      { task: { ...roundReview, query: 'sprite atlas loading' } },
    )
    expect(result.selected.map((item) => item.entry.id)).toEqual(['ov', 'sq'])
    expect(result.selected[0]?.weight).toBeGreaterThan(0)
  })

  test('semantic cosines rank like selectForTask, without making an entry apply', () => {
    const scope = { repos: ['work:acme/square/web'] }
    const result = pick(
      [
        entry({ id: 'a', scope }),
        entry({ id: 'b', scope }),
        entry({ id: 'far', scope: { repos: ['work:x/y'] } }),
      ],
      {
        semantic: new Map([
          ['b', 0.8],
          ['a', 0.1],
          ['far', 0.99],
        ]),
      },
    )
    expect(result.selected.map((item) => item.entry.id)).toEqual(['b', 'a'])
  })

  test('stays within the budget and is empty when nothing fits', () => {
    const scope = { repos: ['work:acme/square/web'] }
    const long = entry({ id: 'long', scope, body: 'x'.repeat(4000) })
    const short = entry({ id: 'short', scope })
    const result = pick([long, short], { budgetTokens: 200 })
    expect(result.selected.map((item) => item.entry.id)).toEqual(['short'])
    expect(result.omitted.map((item) => item.entry.id)).toEqual(['long'])
    expect(result.tokens).toBeLessThanOrEqual(200)
    expect(pick([long], { budgetTokens: 200 })).toMatchObject({ markdown: '', tokens: 0 })
    expect(pick([short], { neighbours: [] }).selected).toEqual([])
  })
})
