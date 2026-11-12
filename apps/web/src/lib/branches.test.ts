import { expect, test } from 'bun:test'

import type { BranchesOverview, BranchesRepoRow } from '@holtkeeper/api'

import {
  authorTotals,
  branchChanges,
  branchKpis,
  branchListRows,
  branchSortValue,
  branchesSort,
  filterBranchRepos,
  filterBranchesExceptReason,
  oldestFirst,
  parseBranchesSearch,
  reasonCounts,
  selectionByRepo,
  selectionText,
  signed,
} from './branches.ts'
import { sortRows } from './table-sort.ts'

const repoRow = (path: string, patch: Partial<BranchesRepoRow>): BranchesRepoRow => ({
  repo: { forge: 'acme', path },
  groups: [],
  analysisId: `rec-${path}`,
  createdAt: '2026-01-05T00:00:00Z',
  defaultBranch: 'main',
  staleDays: 90,
  total: 0,
  open: 0,
  cleanup: 0,
  merged: 0,
  closed: 0,
  stale: 0,
  authors: [],
  branches: [],
  more: 0,
  ...patch,
})

const overview: BranchesOverview = {
  repos: [
    repoRow('acme/storefront', {
      groups: ['Web'],
      total: 20,
      open: 4,
      cleanup: 3,
      merged: 1,
      closed: 1,
      stale: 1,
      oldestDays: 400,
      delta: { total: 2, cleanup: 2, merged: 1, closed: 0, stale: 1 },
      authors: [
        { author: 'Teo R.', cleanup: 2, merged: 1, closed: 0, stale: 1, oldestDays: 400 },
        { author: 'Ana S.', cleanup: 1, merged: 0, closed: 1, stale: 0, oldestDays: 40 },
      ],
      branches: [
        {
          name: 'feat/old-widget',
          reason: 'stale',
          committedAt: '2024-12-01T00:00:00Z',
          ageDays: 400,
          author: 'Teo R.',
          webUrl: 'https://gitlab.acme.dev/acme/storefront/-/tree/feat/old-widget',
        },
        {
          name: 'fix/ABC-123',
          reason: 'closed',
          committedAt: '2025-11-26T00:00:00Z',
          ageDays: 40,
          author: 'Ana S.',
          mergeRequest: { iid: 7, state: 'closed', title: 'Fix ABC-123', url: 'https://x/7' },
        },
        {
          name: 'feat/widgets',
          reason: 'merged',
          committedAt: '2025-12-26T00:00:00Z',
          ageDays: 10,
          author: 'Teo R.',
          mergeRequest: { iid: 9, state: 'merged', title: 'Widgets', url: 'https://x/9' },
        },
      ],
    }),
    repoRow('acme/ledger-api', {
      groups: ['Payments'],
      staleDays: 60,
      total: 5,
      open: 1,
      cleanup: 2,
      merged: 2,
      oldestDays: 120,
      more: 1,
      authors: [{ author: 'Teo R.', cleanup: 2, merged: 2, closed: 0, stale: 0, oldestDays: 120 }],
      branches: [
        {
          name: 'chore/deps',
          reason: 'merged',
          committedAt: '2025-09-01T00:00:00Z',
          ageDays: 120,
        },
      ],
    }),
    repoRow('acme/notify-svc', {
      delta: { total: 0, cleanup: 0, merged: 0, closed: 0, stale: 0 },
    }),
  ],
}

const rows = branchListRows(overview)

test('rows carry their repository and groups', () => {
  expect(rows.map((row) => row.key)).toEqual([
    'acme:acme/storefront#feat/old-widget',
    'acme:acme/storefront#fix/ABC-123',
    'acme:acme/storefront#feat/widgets',
    'acme:acme/ledger-api#chore/deps',
  ])
  expect(rows[3]).toMatchObject({ repoKey: 'acme:acme/ledger-api', groups: ['Payments'] })
})

test('rows go oldest first and sort by any column with empty values last', () => {
  expect(oldestFirst(rows).map((row) => row.name)).toEqual([
    'feat/old-widget',
    'chore/deps',
    'fix/ABC-123',
    'feat/widgets',
  ])
  const byReason = sortRows(rows, { key: 'reason', direction: 'asc' }, branchSortValue)
  expect(byReason.map((row) => row.reason)).toEqual(['merged', 'merged', 'closed', 'stale'])
  const byAuthor = sortRows(rows, { key: 'author', direction: 'desc' }, branchSortValue)
  expect(byAuthor.at(-1)?.name).toBe('chore/deps')
  const byMr = sortRows(rows, { key: 'mr', direction: 'asc' }, branchSortValue)
  expect(byMr.map((row) => row.mergeRequest?.iid)).toEqual([7, 9, undefined, undefined])
})

test('filters narrow by repository, text, author and age; reason counts follow them', () => {
  const names = (search: Parameters<typeof filterBranchesExceptReason>[1]) =>
    filterBranchesExceptReason(rows, search).map((row) => row.name)
  expect(names({ repo: 'acme:acme/ledger-api' })).toEqual(['chore/deps'])
  expect(names({ q: 'abc' })).toEqual(['fix/ABC-123'])
  expect(names({ q: 'ana' })).toEqual(['fix/ABC-123'])
  expect(names({ author: ['unknown'] })).toEqual(['chore/deps'])
  expect(names({ age: '90' })).toEqual(['feat/old-widget', 'chore/deps'])
  expect(reasonCounts(filterBranchesExceptReason(rows, { age: '30' }))).toEqual({
    all: 3,
    merged: 1,
    closed: 1,
    stale: 1,
  })
})

test('strip figures come from the stored counts of the repositories', () => {
  expect(branchKpis(overview.repos)).toEqual({
    repos: 3,
    withCleanup: 2,
    cleanup: 5,
    merged: 3,
    closed: 1,
    stale: 1,
    total: 25,
    open: 5,
    oldestDays: 400,
    staleDays: [60, 90],
    delta: 2,
    compared: 2,
    more: 1,
  })
  const ledger = filterBranchRepos(overview.repos, { repo: 'acme:acme/ledger-api' })
  expect(branchKpis(ledger)).toMatchObject({ repos: 1, cleanup: 2, compared: 0 })
  expect(branchKpis(ledger).delta).toBeUndefined()
})

test('authors add up across repositories and keep the oldest age', () => {
  expect(authorTotals(overview.repos)).toEqual([
    { author: 'Teo R.', cleanup: 4, merged: 3, closed: 0, stale: 1, oldestDays: 400 },
    { author: 'Ana S.', cleanup: 1, merged: 0, closed: 1, stale: 0, oldestDays: 40 },
  ])
})

test('changes list only repositories whose counts moved', () => {
  expect(branchChanges(overview.repos).map((change) => change.repoKey)).toEqual([
    'acme:acme/storefront',
  ])
  expect([signed(3), signed(-2), signed(0)]).toEqual(['+3', '−2', '±0'])
})

test('a selection groups by repository, most branches first, and copies as lines', () => {
  const selected = new Set([
    'acme:acme/ledger-api#chore/deps',
    'acme:acme/storefront#fix/ABC-123',
    'acme:acme/storefront#feat/widgets',
  ])
  const groups = selectionByRepo(rows, selected)
  expect(groups.map((group) => [group.repoKey, group.branches.length])).toEqual([
    ['acme:acme/storefront', 2],
    ['acme:acme/ledger-api', 1],
  ])
  expect(selectionText(groups)).toBe(
    'acme/storefront fix/ABC-123\nacme/storefront feat/widgets\nacme/ledger-api chore/deps',
  )
})

test('branches search keeps known values and drops the rest', () => {
  expect(
    parseBranchesSearch({
      repo: 'acme:acme/widgets',
      q: 'feat',
      reason: 'merged',
      author: 'Teo R.,Ana S.',
      age: '90',
      sort: 'age',
      dir: 'desc',
      panel: 'authors',
      extra: 'x',
    }),
  ).toEqual({
    repo: 'acme:acme/widgets',
    q: 'feat',
    reason: 'merged',
    author: ['Teo R.', 'Ana S.'],
    age: '90',
    sort: 'age',
    dir: 'desc',
    panel: 'authors',
  })
  expect(parseBranchesSearch({ repo: '', reason: 'gone', age: '7', panel: 'x' })).toEqual({})
  expect(branchesSort({ sort: 'branch' })).toEqual({ key: 'branch', direction: 'asc' })
  expect(branchesSort({})).toBeNull()
})
