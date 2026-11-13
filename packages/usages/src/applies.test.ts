import { describe, expect, test } from 'bun:test'

import type { ApplicabilityContext } from '@holtkeeper/analyzer'

import { hasGoModule, usagesApplies } from './applies.ts'

const repo = { forge: 'gitlab', path: 'acme/widgets' }

const context = (files: string[], list = true): ApplicabilityContext => {
  const forge = {
    readFile: async (_repo: string, path: string) => (files.includes(path) ? '' : undefined),
    ...(list
      ? {
          listFiles: async () =>
            files.map((path) => ({ path, name: path.split('/').at(-1), type: 'file' as const })),
        }
      : {}),
  }
  return { repo, forge }
}

describe('usagesApplies', () => {
  test('applies to a root package.json, go.mod or go.work', async () => {
    expect(await usagesApplies(context(['package.json'], false))).toBe(true)
    expect(await usagesApplies(context(['go.mod'], false))).toBe(true)
    expect(await usagesApplies(context(['go.work'], false))).toBe(true)
    expect(await usagesApplies(context(['README.md']))).toBe(false)
  })

  test('finds nested Go modules when the forge lists the tree', async () => {
    expect(await usagesApplies(context(['services/api/go.mod']))).toBe(true)
    expect(await usagesApplies(context(['services/api/go.mod'], false))).toBe(false)
    expect(await hasGoModule()(context(['vendor/example.com/x/go.mod']))).toBe(false)
    expect(await hasGoModule()(context(['testdata/mod/go.mod', '.cache/go.mod']))).toBe(false)
    expect(await hasGoModule()(context(['a/b/c/d/e/go.mod']))).toBe(false)
    expect(await hasGoModule(5)(context(['a/b/c/d/e/go.mod']))).toBe(true)
  })
})
