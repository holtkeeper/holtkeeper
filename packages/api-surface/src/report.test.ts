import { expect, test } from 'bun:test'

import { diffPackage } from './diff.ts'
import type { ApiPackage } from './model.ts'
import { importPath, renderDiff, renderPackage } from './render.ts'
import { apiSurfaceAnalysis, apiSurfaceReport } from './report.ts'

const ui = (version: string, names: string[]): ApiPackage => ({
  name: '@acme/ui',
  version,
  private: false,
  dir: 'packages/ui',
  entries: [
    {
      subpath: './button',
      file: 'packages/ui/src/button.ts',
      symbols: names.map((name, index) => ({
        name,
        kind: 'function',
        signature: `function ${name}(): void`,
        ...(index === 0 ? { doc: `Makes a ${name}.` } : {}),
        file: 'packages/ui/src/button.ts',
        line: index + 1,
      })),
    },
  ],
})

test('importPath joins the package and subpath', () => {
  expect(importPath('@acme/ui', '.')).toBe('@acme/ui')
  expect(importPath('@acme/ui', './button')).toBe('@acme/ui/button')
})

test('renderPackage lists imports, docs and declarations', () => {
  const text = renderPackage(ui('1.0.0', ['button', 'link']), {
    repo: 'work:acme/ui',
    ref: 'v1.0.0',
  })
  expect(text).toContain('# @acme/ui@1.0.0')
  expect(text).toContain('Repository: `work:acme/ui`, folder `packages/ui`, ref `v1.0.0`')
  expect(text).toContain('## `@acme/ui/button`')
  expect(text).toContain(
    '### button (function)\n\nMakes a button.\n\n```ts\nfunction button(): void\n```',
  )
  expect(renderPackage(ui('1.0.0', ['button']), { docs: false })).not.toContain('Makes a button.')
})

test('renderDiff shows the semver verdict', () => {
  const text = renderDiff(diffPackage(ui('1.0.0', ['button', 'link']), ui('1.1.0', ['button'])))
  expect(text).toContain('# @acme/ui: 1.0.0 → 1.1.0')
  expect(text).toContain('**Semver:** 1 export removed, but 1.0.0 → 1.1.0 is not a major bump.')
  expect(text).toContain('## removed: `@acme/ui/button → link` (function)')
})

test('the report counts documented exports and removals since the previous record', () => {
  const report = apiSurfaceReport(
    { packages: [ui('1.1.0', ['button'])] },
    { previous: { packages: [ui('1.0.0', ['button', 'link'])] }, compareTo: 'v1.0.0' },
  )
  const values = Object.fromEntries(report.metrics.map((m) => [m.id, m.value]))
  expect(values).toMatchObject({ packages: 1, exports: 1, documented: 100, removed: 1 })
  expect(report.sections.map((section) => section.id)).toEqual(['packages', 'changes'])
  expect(apiSurfaceAnalysis.summarize({ packages: [] }).map((m) => m.id)).toEqual([
    'packages',
    'exports',
    'deprecated',
  ])
})
