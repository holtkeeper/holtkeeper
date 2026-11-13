import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ChangedGoModule,
  changedGoModules,
  goGuidelinesSection,
  goMajorMinor,
  guidelinesForModules,
} from './prompt.ts'
import type { GoGuideline, GoGuidelineSet } from './schema.ts'
import { bundledGoGuidelines } from './snapshot.ts'

const guideline = (id: string, since: string, before = ['old()'], after = ['fresh()']) =>
  ({
    id,
    since_version: since,
    guideline: `Prefer the ${id} form.`,
    details: 'Clearer.',
    examples: [{ before, after }],
  }) satisfies GoGuideline

const set: GoGuidelineSet = {
  tag: 'v9.9.9',
  source: 'github',
  guidelines: [
    guideline('shape_iter', '1.24'),
    guideline('shape_min', '1.21', ['m := widgets.Smallest(a, b)'], ['m := min(a, b)']),
    guideline('shape_since', '1.0'),
  ],
}
const module = (go: string, dir = '.'): ChangedGoModule => ({ dir, go, files: ['main.go'] })

describe('goMajorMinor', () => {
  test('reads major.minor from go directive versions', () => {
    expect(goMajorMinor('1.22')).toBe('1.22')
    expect(goMajorMinor('1.22.3')).toBe('1.22')
    expect(goMajorMinor('1.23rc1')).toBe('1.23')
    expect(goMajorMinor('go1.21.0')).toBe('1.21')
    expect(goMajorMinor('banana')).toBeUndefined()
  })
})

describe('changedGoModules', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'review-go-'))
    await mkdir(join(dir, 'cmd/shapes'), { recursive: true })
    await mkdir(join(dir, 'tools/gen'), { recursive: true })
    await mkdir(join(dir, 'legacy'), { recursive: true })
    await writeFile(
      join(dir, 'go.mod'),
      'module example.com/acme/shapes\n\n// go 1.10 in a comment\ngo 1.22.3\n',
    )
    await writeFile(join(dir, 'tools/go.mod'), 'module example.com/acme/shapes/tools\n')
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  test('maps each Go file to its nearest go.mod', async () => {
    const modules = await changedGoModules(dir, [
      'cmd/shapes/main.go',
      'shapes.go',
      'tools/gen/gen.go',
      'README.md',
    ])
    expect(modules).toEqual([
      { dir: '.', go: '1.22', files: ['cmd/shapes/main.go', 'shapes.go'] },
      { dir: 'tools', go: '1.16', files: ['tools/gen/gen.go'] },
    ])
  })

  test('is empty without Go files or without a go.mod', async () => {
    expect(await changedGoModules(dir, ['src/app.ts', 'go.sum'])).toEqual([])
    const bare = await mkdtemp(join(tmpdir(), 'review-go-bare-'))
    try {
      expect(await changedGoModules(bare, ['main.go'])).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe('guidelinesForModules', () => {
  test('keeps guidelines no newer than the newest module', () => {
    expect(guidelinesForModules(set.guidelines, [module('1.21')]).map((g) => g.id)).toEqual([
      'shape_min',
      'shape_since',
    ])
    expect(guidelinesForModules(set.guidelines, [module('1.18'), module('1.24', 'b')]).length).toBe(
      3,
    )
    expect(guidelinesForModules(set.guidelines, [])).toEqual([])
  })
})

describe('goGuidelinesSection', () => {
  test('lists applicable guidelines with the rules and the source', () => {
    const section = goGuidelinesSection({ set, modules: [module('1.21')] })
    expect(section).toContain(
      'third-party reference data from JetBrains/go-modern-guidelines v9.9.9',
    )
    expect(section).toContain('`.` go 1.21 (1 changed file)')
    expect(section).toContain('severity `minor` at most')
    expect(section).toContain('would not compile')
    expect(section).toContain('[Go 1.21+] shape_min')
    expect(section).toContain('    m := min(a, b)')
    expect(section).not.toContain('shape_iter')
  })

  test('puts guidelines whose replaced calls appear in the added code first', () => {
    const section = goGuidelinesSection({
      set: {
        ...set,
        guidelines: [
          guideline('shape_since', '1.0'),
          guideline('shape_min', '1.21', ['m := widgets.Smallest(a, b)'], ['m := min(a, b)']),
        ],
      },
      modules: [module('1.22')],
      addedCode: 'x := widgets.Smallest(p, q)',
    })
    expect(section.indexOf('shape_min')).toBeLessThan(section.indexOf('shape_since'))
  })

  test('is empty when no guideline applies', () => {
    expect(goGuidelinesSection({ set, modules: [] })).toBe('')
    expect(
      goGuidelinesSection({
        set: { ...set, guidelines: [guideline('shape_iter', '1.24')] },
        modules: [module('1.20')],
      }),
    ).toBe('')
  })

  test('stays within the character cap and counts what it left out', async () => {
    const bundled = await bundledGoGuidelines()
    const full = goGuidelinesSection({ set: bundled, modules: [module('1.30')] })
    expect(full.length).toBeLessThanOrEqual(10_000)
    const small = goGuidelinesSection({ set: bundled, modules: [module('1.30')], maxChars: 2000 })
    expect(small.length).toBeLessThanOrEqual(2000)
    expect(small).toMatch(/\(\d+ more guidelines left out for length\.\)$/)
  })
})
