import { describe, expect, test } from 'bun:test'

import {
  familyOf,
  frameworkOf,
  jaccard,
  repoNeighbours,
  repoSimilarity,
  suggestFamilies,
  suggestionKey,
} from './families.ts'

const shop = ['react', 'react-dom', 'widget-kit', 'shape-utils', 'foo-router', 'bar-state']

describe('suggestFamilies', () => {
  test('groups near-identical apps with the same framework and toolchain', () => {
    const suggestions = suggestFamilies([
      { repo: 'work:shop/app-north', dependencies: shop, toolchain: ['node', 'pnpm'] },
      {
        repo: 'work:shop/app-south',
        dependencies: [...shop, 'extra-lib'],
        toolchain: ['pnpm', 'node'],
      },
      { repo: 'work:shop/app-east', dependencies: shop.slice(0, 5), toolchain: ['node', 'pnpm'] },
      { repo: 'work:shop/app-west', dependencies: shop, toolchain: ['node', 'npm'] },
      { repo: 'work:tools/cli', dependencies: ['commander', 'some-lib'], toolchain: ['node'] },
      { repo: 'work:tools/empty', dependencies: [] },
    ])
    expect(suggestions).toEqual([
      {
        name: 'shop/app (react)',
        members: ['work:shop/app-east', 'work:shop/app-north', 'work:shop/app-south'],
        similarity: 0.714,
        framework: 'react',
        toolchain: ['node', 'pnpm'],
        shared: ['foo-router', 'react', 'react-dom', 'shape-utils', 'widget-kit'],
      },
    ])
  })

  test('names come from the deepest shared folder and the shared words of repository names', () => {
    const names = suggestFamilies([
      { repo: 'work:acme/games/board-front', dependencies: shop },
      { repo: 'work:acme/games/cards-front', dependencies: shop },
      { repo: 'work:acme/media/player', dependencies: ['fooUtil', 'bar-lib', 'baz-kit'] },
      { repo: 'work:acme/media/editor', dependencies: ['fooUtil', 'bar-lib', 'baz-kit'] },
    ]).map((suggestion) => suggestion.name)
    expect(names.toSorted()).toEqual(['games/front (react)', 'media'])
  })

  test('alike repositories in different folders are suggested together, named by their shape', () => {
    const suggestions = suggestFamilies([
      { repo: 'work:acme/round/web', dependencies: shop, toolchain: ['node', 'pnpm'] },
      { repo: 'work:acme/square/web', dependencies: shop, toolchain: ['node', 'pnpm'] },
      { repo: 'work:acme/round/api', dependencies: ['fastify', 'some-lib'], toolchain: ['node'] },
    ])
    expect(suggestions.map((s) => [s.name, s.members])).toEqual([
      ['acme/*/web (react)', ['work:acme/round/web', 'work:acme/square/web']],
    ])
  })

  test('suggestions that would share a name are told apart by a dependency only they share', () => {
    const left = ['react', 'widget-kit', 'left-lib', 'left-ui', 'left-state']
    const right = ['react', 'widget-kit', 'right-lib', 'right-ui', 'right-state']
    const names = suggestFamilies([
      { repo: 'work:acme/one/app', dependencies: left },
      { repo: 'work:acme/two/app', dependencies: left },
      { repo: 'work:acme/three/app', dependencies: right },
      { repo: 'work:acme/four/app', dependencies: right },
    ]).map((suggestion) => suggestion.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.toSorted()).toEqual([
      'acme/*/app (react) · left-lib',
      'acme/*/app (react) · right-lib',
    ])
  })

  test('complete linkage keeps chains of loosely related repos apart', () => {
    const a = ['l1', 'l2', 'l3', 'l4', 'l5']
    const b = ['l2', 'l3', 'l4', 'l5', 'l6']
    const c = ['l3', 'l4', 'l5', 'l6', 'l7']
    const suggestions = suggestFamilies(
      [
        { repo: 'work:x/a', dependencies: a },
        { repo: 'work:x/b', dependencies: b },
        { repo: 'work:x/c', dependencies: c },
      ],
      { threshold: 0.6 },
    )
    expect(suggestions.map((s) => s.members)).toEqual([['work:x/a', 'work:x/b']])
    expect(suggestions[0]?.name).toBe('x')
  })

  test('respects threshold, minSize and exclude, and ignores input order', () => {
    const signals = [
      { repo: 'work:a/one', dependencies: ['p', 'q', 'r'] },
      { repo: 'work:a/two', dependencies: ['p', 'q', 'r'] },
      { repo: 'work:a/three', dependencies: ['p', 'q', 's'] },
    ]
    expect(suggestFamilies(signals).map((s) => s.members)).toEqual([['work:a/one', 'work:a/two']])
    expect(suggestFamilies(signals, { threshold: 0.5 })[0]?.members).toHaveLength(3)
    expect(suggestFamilies(signals, { threshold: 0.5, minSize: 4 })).toEqual([])
    expect(suggestFamilies(signals, { exclude: ['work:a/one'] })).toEqual([])
    expect(suggestFamilies(signals.toReversed())).toEqual(suggestFamilies(signals))
  })
})

describe('helpers', () => {
  test('frameworkOf prefers meta-frameworks', () => {
    expect(frameworkOf(['react', 'next'])).toBe('next')
    expect(frameworkOf(['vue'])).toBe('vue')
    expect(frameworkOf(['some-lib'])).toBeUndefined()
  })

  test('jaccard', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
    expect(jaccard(new Set(), new Set())).toBe(0)
  })

  test('familyOf finds the family holding a repository', () => {
    const family = {
      id: 'f1',
      name: 'Widgets',
      members: ['work:a/one'],
      createdBy: 'jane',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    }
    expect(familyOf([family], 'work:a/one')).toBe(family)
    expect(familyOf([family], 'work:a/two')).toBeUndefined()
  })
})

test('a suggestion key ignores member order and duplicates', () => {
  expect(suggestionKey(['w:b', 'w:a', 'w:b'])).toBe('w:a,w:b')
  expect(suggestionKey(['w:a', 'w:b'])).toBe(suggestionKey(['w:b', 'w:a']))
})

describe('repoSimilarity', () => {
  test('is the dependency Jaccard within one framework and toolchain, else 0', () => {
    const a = { repo: 'work:acme/round/web', dependencies: shop, toolchain: ['node', 'pnpm'] }
    const b = {
      repo: 'work:acme/square/web',
      dependencies: [...shop, 'extra-lib'],
      toolchain: ['pnpm', 'node'],
    }
    expect(repoSimilarity(a, b)).toBeCloseTo(6 / 7)
    expect(repoSimilarity(b, a)).toBe(repoSimilarity(a, b))
    expect(repoSimilarity(a, { ...b, toolchain: ['node', 'npm'] })).toBe(0)
    expect(repoSimilarity(a, { ...b, dependencies: ['vue', ...shop.slice(2)] })).toBe(0)
  })
})

describe('repoNeighbours', () => {
  const signals = [
    { repo: 'work:acme/round/web', dependencies: shop },
    { repo: 'work:acme/square/web', dependencies: [...shop, 'extra-lib'] },
    { repo: 'work:acme/oval/web', dependencies: shop.slice(0, 4) },
    { repo: 'work:acme/hex/web', dependencies: shop.slice(0, 3) },
    { repo: 'work:acme/round/api', dependencies: ['express', 'some-lib'] },
    { repo: 'work:acme/blank/web', dependencies: [] },
  ]

  test('lists the most alike repositories above the minimum, best first', () => {
    expect(repoNeighbours(signals, 'work:acme/round/web')).toEqual([
      { repo: 'work:acme/square/web', similarity: 0.857 },
      { repo: 'work:acme/oval/web', similarity: 0.667 },
      { repo: 'work:acme/hex/web', similarity: 0.5 },
    ])
    expect(repoNeighbours(signals, 'work:acme/round/web', { limit: 1, min: 0.6 })).toEqual([
      { repo: 'work:acme/square/web', similarity: 0.857 },
    ])
  })

  test('is the same for signals in any order', () => {
    expect(repoNeighbours(signals.toReversed(), 'work:acme/round/web')).toEqual(
      repoNeighbours(signals, 'work:acme/round/web'),
    )
  })

  test('leaves out the family, unknown repositories and repositories without dependencies', () => {
    const families = [
      {
        id: 'f-web',
        name: 'Web',
        members: ['work:acme/round/web', 'work:acme/square/web'],
        createdBy: 'someone',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    expect(repoNeighbours(signals, 'work:acme/round/web', { families }).map((n) => n.repo)).toEqual(
      ['work:acme/oval/web', 'work:acme/hex/web'],
    )
    expect(repoNeighbours(signals, 'work:acme/blank/web')).toEqual([])
    expect(repoNeighbours(signals, 'work:acme/unknown')).toEqual([])
    expect(repoNeighbours(signals, 'work:acme/round/api')).toEqual([])
  })
})
