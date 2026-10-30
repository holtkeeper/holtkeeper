import { expect, test } from 'bun:test'

import { nodeAt, sizeTree, visibleChildren } from './tree.ts'

const tree = sizeTree({
  name: 'root',
  children: [
    {
      name: 'a',
      children: [
        { name: 'a1', value: 10 },
        { name: 'a2', value: 30 },
      ],
    },
    { name: 'b', value: 5 },
    { name: 'empty', children: [] },
  ],
})

test('sums parents, sorts and drops empty branches', () => {
  expect(tree.value).toBe(45)
  expect(tree.children?.map((c) => [c.name, c.value])).toEqual([
    ['a', 40],
    ['b', 5],
  ])
  expect(tree.children?.[0]?.children?.[0]?.name).toBe('a2')
})

test('walks paths and stops at unknown names', () => {
  expect(nodeAt(tree, ['a', 'a1']).node.value).toBe(10)
  expect(nodeAt(tree, ['a', 'zzz']).path).toEqual(['a'])
  expect(nodeAt(tree, []).node.name).toBe('root')
})

test('folds small children into Other', () => {
  const wide = sizeTree({
    name: 'r',
    children: Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, value: 5 - i })),
  })
  expect(visibleChildren(wide, 3).map((c) => [c.name, c.value])).toEqual([
    ['n0', 5],
    ['n1', 4],
    ['Other (3)', 6],
  ])
})
