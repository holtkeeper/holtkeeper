import { expect, test } from 'bun:test'

import { testIdsAnalyzer } from './analyzer.ts'

test('applies to a frontend whose package.json sits in a subfolder', async () => {
  const applies = testIdsAnalyzer.appliesTo
  const context = {
    repo: { forge: 'work', path: 'shapes/site' },
    forge: {
      readFile: async () => undefined,
      listFiles: async () => [
        { path: 'frontend/package.json', type: 'file' as const },
        { path: 'frontend/src/App.vue', type: 'file' as const },
      ],
    },
  }
  expect(await applies?.(context)).toBe(true)
})

const tree = (paths: string[]) => ({
  repo: { forge: 'work', path: 'shapes/service' },
  forge: {
    readFile: async () => undefined,
    listFiles: async () => paths.map((path) => ({ path, type: 'file' as const })),
  },
})

test('applies only to repositories with template sources somewhere in the tree', async () => {
  const applies = testIdsAnalyzer.appliesTo
  expect(applies).toBeDefined()
  expect(await applies?.(tree(['go.mod', 'internal/geom/area.go']))).toBe(false)
  expect(await applies?.(tree(['go.mod', 'web/templates/page.html']))).toBe(true)
  expect(await applies?.(tree(['apps/site/src/Widget.tsx']))).toBe(true)
})
