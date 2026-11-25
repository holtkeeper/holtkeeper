import { describe, expect, test } from 'bun:test'

import type { DependencyRoot, ReleaseCompareRefs } from '@holtkeeper/api'

import {
  defaultRange,
  dependencyChangeCount,
  directCounts,
  hasWorkspaces,
  parseCompareSearch,
  rangeProblem,
  rootFacts,
  rootLabel,
  sameRange,
  sideRange,
  sideText,
  swapRange,
  targetBranch,
  transitiveCounts,
  shownEnvironments,
  versionText,
} from './compare-range.ts'

const refs: Pick<ReleaseCompareRefs, 'versions' | 'branches'> = {
  versions: [
    { tag: 'v1.3.0', version: '1.3.0', sha: 'c3' },
    { tag: 'v1.3.0-rc.1', version: '1.3.0-rc.1', sha: 'c2', prerelease: true },
    { tag: 'v1.2.0', version: '1.2.0', sha: 'c1' },
  ],
  branches: [
    { name: 'main', role: 'target' },
    { name: 'develop', role: 'source' },
  ],
}

const root = (patch: Partial<DependencyRoot> = {}): DependencyRoot => ({
  path: '',
  ecosystem: 'npm',
  direct: [],
  transitive: [],
  counts: {
    added: 0,
    removed: 0,
    updated: 0,
    transitiveAdded: 0,
    transitiveRemoved: 0,
    transitiveUpdated: 0,
  },
  errors: [],
  ...patch,
})

describe('defaultRange', () => {
  test('compares the latest stable version with the stable one before it', () => {
    expect(defaultRange(refs, {})).toEqual({ from: 'v1.2.0', to: 'v1.3.0' })
    const rcFirst = {
      ...refs,
      versions: [
        { tag: 'v1.4.0-rc.1', version: '1.4.0-rc.1', sha: 'c4', prerelease: true },
        ...refs.versions,
      ],
    }
    expect(defaultRange(rcFirst, {})).toEqual({ from: 'v1.2.0', to: 'v1.3.0' })
    expect(defaultRange(rcFirst, { to: 'main' })).toEqual({ from: 'v1.3.0', to: 'main' })
  })

  test('falls back to prereleases when there is no stable version', () => {
    const rcs = {
      ...refs,
      versions: refs.versions.filter((version) => version.prerelease),
    }
    expect(defaultRange(rcs, {})).toEqual({ to: 'v1.3.0-rc.1' })
    expect(
      defaultRange(
        {
          ...refs,
          versions: [
            { tag: 'v0.2.0-rc.1', version: '0.2.0-rc.1', sha: 'b', prerelease: true },
            { tag: 'v0.1.0-rc.1', version: '0.1.0-rc.1', sha: 'a', prerelease: true },
          ],
        },
        {},
      ),
    ).toEqual({ from: 'v0.1.0-rc.1', to: 'v0.2.0-rc.1' })
  })

  test('starts at the version before a chosen one, or the whole history at the oldest', () => {
    expect(defaultRange(refs, { to: 'v1.3.0-rc.1' })).toEqual({ from: 'v1.2.0', to: 'v1.3.0-rc.1' })
    expect(defaultRange(refs, { to: 'v1.2.0' })).toEqual({ to: 'v1.2.0' })
  })

  test('starts at the latest version when the end is a branch', () => {
    expect(defaultRange(refs, { to: 'main' })).toEqual({ from: 'v1.3.0', to: 'main' })
  })

  test('keeps what the URL names', () => {
    expect(defaultRange(refs, { from: 'v1.2.0' })).toEqual({ from: 'v1.2.0', to: 'v1.3.0' })
    expect(defaultRange(refs, { from: 'v1.2.0', to: 'main' })).toEqual({
      from: 'v1.2.0',
      to: 'main',
    })
  })

  test('without versions compares the whole target branch, and without either names nothing', () => {
    expect(defaultRange({ ...refs, versions: [] }, {})).toEqual({ to: 'main' })
    expect(defaultRange({ versions: [], branches: [] }, {})).toEqual({})
  })
})

test('sameRange compares both ends', () => {
  expect(sameRange({ from: 'v1.2.0', to: 'v1.3.0' }, { from: 'v1.2.0', to: 'v1.3.0' })).toBe(true)
  expect(sameRange({ to: 'v1.3.0' }, { from: 'v1.2.0', to: 'v1.3.0' })).toBe(false)
})

test('targetBranch picks the target role', () => {
  expect(targetBranch(refs)).toBe('main')
  expect(targetBranch({ versions: [], branches: [{ name: 'develop', role: 'source' }] })).toBe(
    undefined,
  )
})

test('swapRange exchanges the ends and keeps an absent one absent', () => {
  expect(swapRange({ from: 'v1.2.0', to: 'v1.3.0' })).toEqual({ from: 'v1.3.0', to: 'v1.2.0' })
  expect(swapRange({ to: 'v1.2.0' })).toEqual({ from: 'v1.2.0' })
})

describe('rangeProblem', () => {
  test('accepts an older start, a branch end and unknown refs', () => {
    expect(rangeProblem(refs, { from: 'v1.2.0', to: 'v1.3.0' })).toBeUndefined()
    expect(rangeProblem(refs, { from: 'v1.3.0', to: 'main' })).toBeUndefined()
    expect(rangeProblem(refs, { from: 'abc123', to: 'v1.2.0' })).toBeUndefined()
    expect(rangeProblem(refs, { to: 'v1.2.0' })).toBeUndefined()
  })

  test('flags a backwards or empty range', () => {
    expect(rangeProblem(refs, { from: 'v1.3.0', to: 'v1.2.0' })).toContain('newer')
    expect(rangeProblem(refs, { from: 'main', to: 'v1.2.0' })).toContain('target branch')
    expect(rangeProblem(refs, { from: 'v1.2.0', to: 'v1.2.0' })).toContain('same')
  })
})

test('sideText shows the version, else the range; sideRange only a range that adds something', () => {
  expect(sideText({ range: '^2.0.0', version: '2.1.4' })).toBe('2.1.4')
  expect(sideText({ range: '^2.0.0' })).toBe('^2.0.0')
  expect(sideText(undefined)).toBe('')
  expect(sideRange({ range: '^2.0.0', version: '2.1.4' })).toBe('^2.0.0')
  expect(sideRange({ range: '2.1.4', version: '2.1.4' })).toBeUndefined()
  expect(sideRange({ version: 'v0.4.0' })).toBeUndefined()
})

test('root labels and facts', () => {
  expect(rootLabel({ path: '' })).toBe('.')
  expect(rootLabel({ path: 'services/widget' })).toBe('services/widget')
  expect(rootFacts(root({ manager: 'pnpm', lockfile: 'pnpm-lock.yaml' }))).toBe(
    'npm · pnpm · pnpm-lock.yaml',
  )
  expect(rootFacts(root({ ecosystem: 'go', manager: 'go', lockfile: 'go.sum' }))).toBe(
    'go · go.sum',
  )
})

test('counts read in words and add up across roots', () => {
  const counts = {
    added: 2,
    removed: 0,
    updated: 1,
    transitiveAdded: 0,
    transitiveRemoved: 3,
    transitiveUpdated: 14,
  }
  expect(directCounts(counts)).toBe('2 added, 1 updated')
  expect(transitiveCounts(counts)).toBe('14 updated, 3 removed')
  expect(directCounts(root().counts)).toBe('')
  expect(
    dependencyChangeCount({
      roots: [root({ counts }), root({ counts })],
      skipped: 0,
      partial: false,
    }),
  ).toBe(40)
})

test('hasWorkspaces shows the column for nested npm workspaces or several Go modules', () => {
  const change = { name: 'some-lib', change: 'added', field: 'prod' } as const
  expect(hasWorkspaces(root({ direct: [{ ...change, workspace: '.' }] }))).toBe(false)
  expect(hasWorkspaces(root({ direct: [{ ...change, workspace: 'packages/widget-kit' }] }))).toBe(
    true,
  )
  expect(
    hasWorkspaces(
      root({
        ecosystem: 'go',
        direct: [{ ...change, field: 'require', workspace: 'example.com/foo' }],
      }),
    ),
  ).toBe(false)
})

test('parseCompareSearch keeps non-empty strings only', () => {
  expect(
    parseCompareSearch({ repo: 'gitlab:acme/widget-kit', from: '', to: 'v1.2.0', x: 1 }),
  ).toEqual({
    repo: 'gitlab:acme/widget-kit',
    to: 'v1.2.0',
  })
  expect(parseCompareSearch({ from: 3 })).toEqual({})
})

describe('versionText', () => {
  test('names the environments that run a version', () => {
    expect(versionText({ tag: 'v1.2.0', environments: ['staging', 'prod'] })).toBe(
      'v1.2.0 (staging, prod)',
    )
    expect(versionText({ tag: 'v1.1.0' })).toBe('v1.1.0')
  })
})

describe('shownEnvironments', () => {
  test('shows the first few and counts the rest', () => {
    expect(shownEnvironments(['a', 'b', 'c', 'd', 'e'])).toEqual({
      shown: ['a', 'b', 'c'],
      more: 2,
    })
    expect(shownEnvironments(undefined)).toEqual({ shown: [], more: 0 })
  })
})
