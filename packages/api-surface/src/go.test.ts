import { afterAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { apiSurfaceAnalyzer } from './analyzer.ts'
import { hasGoModule } from './applies.ts'
import { extractGoApi, goModuleVersions, tagsAtHead } from './go.ts'
import type { ApiSurfaceData } from './model.ts'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function checkout(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'api-surface-go-'))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const service = {
  'go.mod': 'module gitlab.example/shapes/painter\n\ngo 1.22\n',
  'cmd/painter/main.go': 'package main\n\nfunc main() {}\n',
  'cmd/tool/main.go': 'package main\n\nfunc main() {}\n',
  'internal/canvas/canvas.go': [
    '// Package canvas draws shapes.',
    'package canvas',
    '',
    '// Canvas holds pixels.',
    'type Canvas struct {',
    '\tWidth int',
    '}',
    '',
    '// Fill paints everything.',
    'func (c *Canvas) Fill(color string) {}',
  ].join('\n'),
  'internal/canvas/canvas_test.go': 'package canvas\n\nfunc TestHidden() {}\n',
  'vendor/example.com/acme/widgets/w.go': 'package widgets\n\nfunc Vendored() {}\n',
}

const library = {
  'go.mod': 'module example.com/acme/widgets\n\ngo 1.22\n',
  'widgets.go': [
    '// Package widgets builds widgets.',
    'package widgets',
    '',
    'func New() int { return 1 }',
  ].join('\n'),
  'geom/point.go': [
    'package geom',
    '',
    '// Point is a point.',
    'type Point struct {',
    '\tX, Y int',
    '}',
  ].join('\n'),
  'testdata/fake.go': 'package fake\n\nfunc Fake() {}\n',
  'shapes/go.mod': 'module example.com/acme/widgets/shapes/v2\n\ngo 1.22\n',
  'shapes/circle.go': ['package shapes', '', '// Circle is round.', 'type Circle struct{}'].join(
    '\n',
  ),
}

test('a service of cmd/ and internal/ lists internal packages as private and counts main ones', async () => {
  const dir = await checkout(service)
  const { packages, modules } = await extractGoApi({ dir })
  expect(packages.map((pkg) => [pkg.name, pkg.private, pkg.dir])).toEqual([
    ['gitlab.example/shapes/painter/internal/canvas', true, 'internal/canvas'],
  ])
  expect(packages[0]?.ecosystem).toBe('Go')
  expect(packages[0]?.module).toBe('gitlab.example/shapes/painter')
  expect(packages[0]?.entries[0]?.symbols.map((symbol) => symbol.name)).toEqual([
    'Canvas',
    'Canvas.Fill',
  ])
  expect(packages[0]?.entries[0]?.symbols[0]?.file).toBe('internal/canvas/canvas.go')
  expect(modules).toEqual([
    {
      path: 'gitlab.example/shapes/painter',
      dir: '.',
      packages: 0,
      internalPackages: 1,
      mainPackages: 2,
    },
  ])
  const without = await extractGoApi({ dir, includeInternal: false })
  expect(without.packages).toEqual([])
  expect(without.modules[0]?.internalPackages).toBe(1)
})

test('a library with a nested module gets per-module packages, paths and versions', async () => {
  const dir = await checkout(library)
  const { packages, modules } = await extractGoApi({
    dir,
    versions: new Map([['shapes', 'v2.1.0']]),
  })
  expect(packages.map((pkg) => [pkg.name, pkg.dir, pkg.version, pkg.module])).toEqual([
    ['example.com/acme/widgets', '.', undefined, 'example.com/acme/widgets'],
    ['example.com/acme/widgets/geom', 'geom', undefined, 'example.com/acme/widgets'],
    [
      'example.com/acme/widgets/shapes/v2',
      'shapes',
      'v2.1.0',
      'example.com/acme/widgets/shapes/v2',
    ],
  ])
  const circle = packages.find((pkg) => pkg.dir === 'shapes')?.entries[0]?.symbols[0]
  expect(circle?.file).toBe('shapes/circle.go')
  expect(
    modules.map((module) => [module.path, module.dir, module.version, module.packages]),
  ).toEqual([
    ['example.com/acme/widgets', '.', undefined, 2],
    ['example.com/acme/widgets/shapes/v2', 'shapes', 'v2.1.0', 1],
  ])
  const filtered = await extractGoApi({ dir, exclude: ['geom'], packages: ['example.com/**'] })
  expect(filtered.packages.map((pkg) => pkg.dir)).toEqual(['.', 'shapes'])
})

const modules = [
  { module: 'example.com/acme/widgets', dir: '.' },
  { module: 'example.com/acme/widgets/shapes/v2', dir: 'shapes' },
]

test('goModuleVersions maps tags at HEAD to modules', () => {
  expect(goModuleVersions(['v1.4.0', 'shapes/v2.1.0', 'release-7'], modules)).toEqual(
    new Map([
      ['.', 'v1.4.0'],
      ['shapes', 'v2.1.0'],
    ]),
  )
  expect(goModuleVersions(['v1.3.9', 'v1.4.0'], modules)).toEqual(new Map([['.', 'v1.4.0']]))
  expect(goModuleVersions([], modules, '0123abcd')).toEqual(new Map())
})

test('a run for one module tag versions only that module', () => {
  expect(goModuleVersions(['v1.4.0', 'shapes/v2.1.0'], modules, 'shapes/v2.1.0')).toEqual(
    new Map([['shapes', 'v2.1.0']]),
  )
  expect(goModuleVersions([], modules, 'v1.4.0')).toEqual(new Map([['.', 'v1.4.0']]))
  expect(goModuleVersions(['v1.4.0'], modules, 'main')).toEqual(new Map([['.', 'v1.4.0']]))
})

test('tagsAtHead reads git tags and survives git failing', async () => {
  const ok = createFakeRunner(() => ({ stdout: 'v1.4.0\nshapes/v2.1.0\n' }))
  expect(await tagsAtHead(ok.runner, '/repo')).toEqual(['v1.4.0', 'shapes/v2.1.0'])
  expect(ok.calls[0]?.command).toEqual(['git', 'tag', '--points-at', 'HEAD'])
  expect(ok.calls[0]?.options.cwd).toBe('/repo')
  const lines: string[] = []
  const failed = createFakeRunner(() => ({ exitCode: 128, stderr: 'fatal: not a git repository' }))
  expect(await tagsAtHead(failed.runner, '/repo', (line) => lines.push(line))).toEqual([])
  expect(lines[0]).toContain('not a git repository')
})

const run = (dir: string, stdout: string, ref?: string) => {
  const fake = createFakeRunner(() => ({ stdout }))
  const options = apiSurfaceAnalyzer.options.parse({})
  return {
    calls: fake.calls,
    result: apiSurfaceAnalyzer.run({
      repo: { forge: 'work', path: 'acme/widgets' },
      dir,
      runner: fake.runner,
      options,
      ...(ref ? { ref } : {}),
    }),
  }
}

test('the analyzer versions Go packages from module tags at HEAD', async () => {
  const dir = await checkout(library)
  const { result } = run(dir, 'v1.4.0\nshapes/v2.1.0\n')
  const data: ApiSurfaceData = (await result).data
  expect(data.packages.map((pkg) => [pkg.name, pkg.version])).toEqual([
    ['example.com/acme/widgets', 'v1.4.0'],
    ['example.com/acme/widgets/geom', 'v1.4.0'],
    ['example.com/acme/widgets/shapes/v2', 'v2.1.0'],
  ])
  expect(data.go?.modules.map((module) => module.version)).toEqual(['v1.4.0', 'v2.1.0'])

  const tagRun = run(dir, 'v1.4.0\nshapes/v2.1.0\n', 'shapes/v2.1.0')
  const tagged = (await tagRun.result).data
  expect(tagged.packages.map((pkg) => pkg.version)).toEqual([undefined, undefined, 'v2.1.0'])
})

test('the analyzer merges npm and Go packages and skips git without Go modules', async () => {
  const dir = await checkout({
    'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0', exports: './index.ts' }),
    'index.ts': 'export const one = 1',
  })
  const npmOnly = run(dir, '')
  const data = (await npmOnly.result).data
  expect(data.packages.map((pkg) => pkg.name)).toEqual(['@acme/ui'])
  expect(data.go).toBeUndefined()
  expect(npmOnly.calls).toEqual([])

  const both = await checkout({
    'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0', exports: './index.ts' }),
    'index.ts': 'export const one = 1',
    ...service,
  })
  const merged = (await run(both, '').result).data
  expect(merged.packages.map((pkg) => [pkg.name, pkg.ecosystem])).toEqual([
    ['@acme/ui', undefined],
    ['gitlab.example/shapes/painter/internal/canvas', 'Go'],
  ])
  expect(merged.go?.modules).toHaveLength(1)
})

const forge = (files: string[], list = true) => ({
  readFile: async (_repo: string, file: string) => (files.includes(file) ? '' : undefined),
  ...(list
    ? {
        listFiles: async () => files.map((path) => ({ path, type: 'file' as const })),
      }
    : {}),
})

test('hasGoModule finds root and nested go.mod files', async () => {
  const repo = { forge: 'work', path: 'acme/widgets' }
  const check = hasGoModule()
  expect(await check({ repo, forge: forge(['go.work']) })).toBe(true)
  expect(await check({ repo, forge: forge(['services/api/go.mod']) })).toBe(true)
  expect(await check({ repo, forge: forge(['a/b/c/d/e/go.mod']) })).toBe(false)
  expect(await check({ repo, forge: forge(['vendor/x/go.mod', 'README.md']) })).toBe(false)
  expect(await check({ repo, forge: forge(['services/api/go.mod'], false) })).toBe(false)
  expect(await apiSurfaceAnalyzer.appliesTo?.({ repo, forge: forge(['package.json']) })).toBe(true)
  expect(await apiSurfaceAnalyzer.appliesTo?.({ repo, forge: forge(['README.md']) })).toBe(false)
})
