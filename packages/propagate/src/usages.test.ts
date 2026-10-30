import { describe, expect, test } from 'bun:test'

import { applyUsages } from './bump.ts'
import { bumpRange, isAtLeast, minimumOfRange } from './semver.ts'
import { setJsonString, setYamlScalar } from './text-edit.ts'
import type { PackageTarget } from './types.ts'
import { goModUsages, packageJsonUsages, pnpmWorkspaceUsages } from './usages.ts'

const react: PackageTarget = {
  name: 'react',
  ecosystem: 'npm',
  requested: '19.1.0',
  version: '19.1.0',
}

describe('bumpRange', () => {
  test.each([
    ['^18.2.0', '^19.1.0'],
    ['~18.2', '~19.1.0'],
    ['18.2.0', '19.1.0'],
    ['=18.2.0', '=19.1.0'],
    ['>=18.2.0', '>=19.1.0'],
    ['>=18 <19', '^19.1.0'],
    ['18.x', '^19.1.0'],
    ['^18.0.0 || ^17.0.0', '^19.1.0'],
  ])('%s → %s', (declared, expected) => {
    expect(bumpRange(declared, '19.1.0')).toBe(expected)
  })

  test('leaves protocols, tags and stars alone', () => {
    for (const spec of ['workspace:*', 'catalog:', 'latest', '*', 'file:../x', 'github:a/b'])
      expect(bumpRange(spec, '1.0.0')).toBeUndefined()
  })

  test('compares range floors with the target', () => {
    expect(minimumOfRange('>=1.2 <3 || 0.9.1')).toBe('0.9.1')
    expect(isAtLeast('^19.1.0', '19.1.0')).toBe(true)
    expect(isAtLeast('^18.9.0', '19.1.0')).toBe(false)
  })
})

describe('packageJsonUsages', () => {
  const manifest = `{
  "name": "app",
  "dependencies": { "react": "^18.2.0", "other": "1.0.0" },
  "devDependencies": { "react": "18.2.0" },
  "peerDependencies": { "react": ">=17" },
  "optionalDependencies": { "react": "workspace:*" },
  "overrides": { "react": "18.2.0", "foo": { "react": "~18.1.0" } },
  "pnpm": { "overrides": { "react@<18": "^18.0.0" } },
  "resolutions": { "**/react": "18.2.0" },
  "workspaces": { "packages": ["packages/*"], "catalog": { "react": "^18.3.0" } },
  "catalogs": { "legacy": { "react": "^17.0.0" } }
}
`

  test('finds every declaration style', () => {
    const usages = packageJsonUsages('package.json', manifest, [react])
    const summary = usages.map((usage) => [
      usage.path.join('.'),
      usage.kind,
      usage.next ?? usage.note,
    ])
    expect(summary).toEqual([
      ['dependencies.react', 'prod', '^19.1.0'],
      ['devDependencies.react', 'dev', '19.1.0'],
      ['peerDependencies.react', 'peer', '>=19.1.0'],
      ['optionalDependencies.react', 'optional', 'workspace package of this repository'],
      ['overrides.react', 'override', '19.1.0'],
      ['overrides.foo.react', 'override', '~19.1.0'],
      ['pnpm.overrides.react@<18', 'override', '^19.1.0'],
      ['resolutions.**/react', 'resolution', '19.1.0'],
      ['catalogs.legacy.react', 'catalog', '^19.1.0'],
      ['workspaces.catalog.react', 'catalog', '^19.1.0'],
    ])
  })

  test('applies edits preserving formatting', () => {
    const usages = packageJsonUsages('package.json', manifest, [react])
    const { texts, bumps, notes } = applyUsages({ 'package.json': manifest }, usages)
    expect(notes).toEqual([])
    expect(bumps).toHaveLength(9)
    const edited = texts['package.json']!
    expect(edited).toContain('"dependencies": { "react": "^19.1.0", "other": "1.0.0" },')
    expect(edited).toContain('"optionalDependencies": { "react": "workspace:*" }')
    expect(edited).toContain('"resolutions": { "**/react": "19.1.0" }')
    expect(edited.split('\n')).toHaveLength(manifest.split('\n').length)
    expect(packageJsonUsages('package.json', edited, [react]).filter((u) => u.next)).toEqual([])
  })

  test('marks catalog references and newer declarations without bumping', () => {
    const text =
      '{ "dependencies": { "react": "catalog:legacy" }, "devDependencies": { "react": "^20.0.0" } }'
    const usages = packageJsonUsages('packages/a/package.json', text, [react])
    expect(usages.map((usage) => usage.note)).toEqual([
      'version comes from catalog "legacy"',
      'already newer than the target',
    ])
    expect(usages.every((usage) => usage.next === undefined)).toBe(true)
  })
})

describe('pnpm-workspace.yaml', () => {
  const yaml = `packages:
  - packages/*
catalog:
  react: ^18.2.0 # keep in sync
  '@types/react': "18.2.0"
catalogs:
  legacy:
    react: '17.0.2'
overrides:
  react@<18: 18.0.0
`
  test('finds and edits catalogs and overrides in place', () => {
    const usages = pnpmWorkspaceUsages('pnpm-workspace.yaml', yaml, [react])
    expect(usages.map((usage) => [usage.path.join('.'), usage.next])).toEqual([
      ['catalog.react', '^19.1.0'],
      ['catalogs.legacy.react', '19.1.0'],
      ['overrides.react@<18', '19.1.0'],
    ])
    const { texts } = applyUsages({ 'pnpm-workspace.yaml': yaml }, usages)
    expect(texts['pnpm-workspace.yaml']).toBe(`packages:
  - packages/*
catalog:
  react: ^19.1.0 # keep in sync
  '@types/react': "18.2.0"
catalogs:
  legacy:
    react: '19.1.0'
overrides:
  react@<18: 19.1.0
`)
  })

  test('setYamlScalar refuses missing paths and block values', () => {
    expect(setYamlScalar(yaml, ['catalog', 'vue'], '1')).toBeUndefined()
    expect(setYamlScalar(yaml, ['packages'], '1')).toBeUndefined()
    expect(setYamlScalar(yaml, ['catalog', '@types/react'], '19.0.0')).toContain(
      `'@types/react': "19.0.0"`,
    )
  })
})

describe('setJsonString', () => {
  test('keeps comments and only replaces strings', () => {
    const text = '{\n  // comment\n  "a": { "b": "1" },\n  "n": 1,\n}\n'
    expect(setJsonString(text, ['a', 'b'], '2')).toBe(
      '{\n  // comment\n  "a": { "b": "2" },\n  "n": 1,\n}\n',
    )
    expect(setJsonString(text, ['n'], '2')).toBeUndefined()
    expect(setJsonString(text, ['missing'], '2')).toBeUndefined()
  })
})

describe('goModUsages', () => {
  test('reads single and block requires', () => {
    const goMod = `module example.com/app

go 1.22

require github.com/a/lib v1.2.0

require (
\tgithub.com/b/other v0.1.0 // indirect
\tgithub.com/a/lib/v2 v2.0.0
)
`
    const target: PackageTarget = {
      name: 'github.com/a/lib',
      ecosystem: 'Go',
      requested: 'v1.4.0',
      version: 'v1.4.0',
    }
    const newer: PackageTarget = { ...target, name: 'github.com/a/lib/v2', version: 'v2.0.0' }
    expect(goModUsages('go.mod', goMod, [target, newer])).toEqual([
      expect.objectContaining({ package: 'github.com/a/lib', declared: 'v1.2.0', next: 'v1.4.0' }),
      expect.objectContaining({ package: 'github.com/a/lib/v2', declared: 'v2.0.0' }),
    ])
  })
})
