import { expect, test } from 'bun:test'

import { i18nAnalyzer } from './analyzer.ts'

const tree = (paths: string[]) => ({
  repo: { forge: 'work', path: 'shapes/service' },
  forge: {
    readFile: async () => undefined,
    listFiles: async () => paths.map((path) => ({ path, type: 'file' as const })),
  },
})

test('applies only to repositories with source files somewhere in the tree', async () => {
  const applies = i18nAnalyzer.appliesTo
  expect(applies).toBeDefined()
  expect(await applies?.(tree(['go.mod', 'internal/geom/area.go', 'locales/en.json']))).toBe(false)
  expect(await applies?.(tree(['go.mod', 'web/src/app.ts']))).toBe(true)
  expect(await applies?.(tree(['packages/ui/src/Widget.vue']))).toBe(true)
})
