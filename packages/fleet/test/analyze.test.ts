import { describe, expect, test } from 'bun:test'

import { planChanges } from '@holtkeeper/changes'

import { analyzeFleet, selectLibraries } from '../src/analyze.ts'
import { createFleetAnalyzer } from '../src/analyzer.ts'
import { fleetDataSchema } from '../src/schema.ts'
import type { TemplateSpec } from '../src/templates.ts'
import { fakeForge, fakeGitForge, fakeRegistry } from './fakes.ts'
import { fleetFiles, latestVersions } from './fleet.ts'

const repos = ['acme/web', 'acme/admin', 'acme/shop', 'acme/api', 'acme/gone'].map((path) => ({
  forge: 'work',
  path,
}))

const templates: TemplateSpec[] = [
  { path: '.nvmrc', mode: 'exact', create: true, source: { content: '22\n' } },
  {
    path: 'package.json',
    mode: 'json-subset',
    create: false,
    source: { content: '{"engines":{"node":">=22"}}' },
  },
  {
    path: '.gitlab-ci.yml',
    mode: 'yaml-subset',
    create: true,
    source: { repo: 'work:acme/templates', file: 'gitlab-ci.yml', ref: 'v1' },
  },
  {
    path: 'Dockerfile',
    mode: 'lines-present',
    create: false,
    lines: [
      { pattern: '^FROM golang:1\\.23', line: 'FROM golang:1.23', replaces: '^FROM golang:' },
    ],
  },
]

const run = () => {
  const forge = fakeForge(fleetFiles)
  const registry = fakeRegistry(latestVersions)
  const data = analyzeFleet({
    group: 'acme',
    forgeId: 'work',
    repos,
    forge,
    registry,
    libraries: ['@acme/*', 'github.com/acme/**'],
    templates,
  })
  return { forge, registry, data }
}

describe('analyzeFleet', () => {
  test('collects declared and resolved versions of tracked libraries', async () => {
    const { data, registry } = run()
    const result = await data
    expect(fleetDataSchema.parse(result)).toEqual(result)
    expect(
      result.libraries.map((library) => `${library.ecosystem}:${library.name}:${library.reason}`),
    ).toEqual([
      'npm:@acme/ui:option',
      'Go:github.com/acme/kit:option',
      'npm:react:auto',
      'npm:typescript:auto',
    ])
    const react = result.libraries.find((library) => library.name === 'react')
    expect(react?.latest).toBe('19.1.0')
    expect(react?.usages).toEqual([
      {
        repo: 'acme/web',
        manifest: 'package.json',
        declared: '^19.0.0',
        resolved: '19.1.0',
        version: '19.1.0',
        kind: 'prod',
      },
      {
        repo: 'acme/web',
        manifest: 'packages/legacy/package.json',
        declared: '^18.2.0',
        resolved: '18.3.1',
        version: '18.3.1',
        kind: 'prod',
      },
      {
        repo: 'acme/admin',
        manifest: 'package.json',
        declared: '^17.0.2',
        resolved: '17.0.2',
        version: '17.0.2',
        kind: 'prod',
      },
      {
        repo: 'acme/shop',
        manifest: 'package.json',
        declared: '^19.1.0',
        resolved: '19.1.0',
        version: '19.1.0',
        kind: 'prod',
      },
    ])
    expect(registry.calls.toSorted()).toEqual([
      'Go:github.com/acme/kit',
      'npm:@acme/ui',
      'npm:react',
      'npm:typescript',
    ])
    expect(result.repos.find((repo) => repo.path === 'acme/web')?.manifests).toEqual([
      'package.json',
      'bun.lock',
      'packages/legacy/package.json',
    ])
    expect(result.repos.find((repo) => repo.path === 'acme/gone')?.error).toContain('404')
  })

  test('compares config files with templates and suggests per-repository changes', async () => {
    const { data, forge } = run()
    const result = await data
    const status = Object.fromEntries(
      result.templates.map((entry) => [`${entry.repo} ${entry.file}`, entry.status]),
    )
    expect(status).toEqual({
      'acme/web .nvmrc': 'identical',
      'acme/admin .nvmrc': 'drifted',
      'acme/shop .nvmrc': 'missing',
      'acme/api .nvmrc': 'identical',
      'acme/web package.json': 'identical',
      'acme/admin package.json': 'drifted',
      'acme/shop package.json': 'drifted',
      'acme/api package.json': 'missing',
      'acme/web .gitlab-ci.yml': 'identical',
      'acme/admin .gitlab-ci.yml': 'drifted',
      'acme/shop .gitlab-ci.yml': 'identical',
      'acme/api .gitlab-ci.yml': 'missing',
      'acme/web Dockerfile': 'missing',
      'acme/admin Dockerfile': 'missing',
      'acme/shop Dockerfile': 'missing',
      'acme/api Dockerfile': 'drifted',
    })
    expect(forge.reads).toContain('acme/templates:gitlab-ci.yml@v1')

    const changes = result.templates.flatMap((entry) => (entry.change ? [entry.change] : []))
    expect(changes.every((change) => change.target?.forge === 'work')).toBe(true)
    expect(
      changes.find(
        (change) => change.target?.path === 'acme/api' && change.edits[0]?.file === 'package.json',
      ),
    ).toBeUndefined()

    const admin = changes.filter((change) => change.target?.path === 'acme/admin')
    const plan = await planChanges(admin, {
      read: async (file) => fleetFiles['acme/admin']?.[file],
    })
    expect(plan.conflicts).toEqual([])
    const files = Object.fromEntries(plan.files.map((file) => [file.file, file.content]))
    expect(files['.nvmrc']).toBe('22\n')
    expect(JSON.parse(files['package.json'] ?? '{}').engines).toEqual({ node: '>=22' })
    expect(files['.gitlab-ci.yml']).toBe(
      'stages:\n  - test\ninclude:\n  - project: acme/ci\n    file: /node.yml\n',
    )

    const api = changes.filter((change) => change.target?.path === 'acme/api')
    const apiPlan = await planChanges(api, { read: async (file) => fleetFiles['acme/api']?.[file] })
    expect(Object.fromEntries(apiPlan.files.map((file) => [file.file, file.content]))).toEqual({
      '.gitlab-ci.yml': 'include:\n  - project: acme/ci\n    file: /node.yml\n',
      Dockerfile: 'FROM golang:1.23\nWORKDIR /src\n',
    })
  })

  test('template sources on other forges are errors, not crashes', async () => {
    const result = await analyzeFleet({
      group: 'acme',
      forgeId: 'work',
      repos: repos.slice(0, 1),
      forge: fakeForge(fleetFiles),
      registry: fakeRegistry({}),
      minRepos: 0,
      templates: [{ path: '.nvmrc', mode: 'exact', create: true, source: { repo: 'other:x/y' } }],
    })
    expect(result.templates[0]?.status).toBe('error')
    expect(result.libraries).toEqual([])
  })

  test('skips archived repositories and notes unexpanded workspace globs', async () => {
    const files = {
      'acme/old': { 'package.json': '{"dependencies":{"react":"^16.0.0"}}' },
      'acme/mono': {
        'package.json': '{"workspaces":["apps/*"],"dependencies":{"react":"^19.0.0"}}',
      },
    }
    const result = await analyzeFleet({
      group: 'acme',
      forgeId: 'work',
      repos: [
        { forge: 'work', path: 'acme/old' },
        { forge: 'work', path: 'acme/mono' },
      ],
      forge: fakeForge(files, { archived: ['acme/old'] }),
      registry: fakeRegistry({}),
      minRepos: 1,
    })
    expect(result.repos[0]?.archived).toBe(true)
    expect(result.libraries[0]?.usages.map((usage) => usage.repo)).toEqual(['acme/mono'])
    expect(result.notes).toEqual([
      {
        repo: 'acme/mono',
        message:
          'workspace globs were not expanded: the forge cannot list files and no lockfile lists the workspaces',
      },
    ])
  })
})

const usage = (repo: string, kind: 'prod' | 'indirect') => ({
  ecosystem: 'Go' as const,
  name: 'golang.org/x/sys',
  usage: { repo, manifest: 'go.mod', declared: 'v0.1.0', kind },
})

test('expands workspace globs through listFiles when the forge has it', async () => {
  const files = {
    'acme/mono': {
      'package.json': '{"workspaces":["apps/*"],"dependencies":{"react":"^19.0.0"}}',
      'apps/one/package.json': '{"name":"one","dependencies":{"react":"^18.0.0"}}',
      'apps/two/package.json': '{"name":"two","dependencies":{"react":"^17.0.0"}}',
      'apps/two/src/index.ts': '',
      'go.mod': 'module example.com/mono\n',
      'go.work': 'use (\n\t.\n\t./services/a\n)\n',
      'services/a/go.mod': 'module example.com/a\nrequire github.com/acme/kit v1.0.0\n',
    },
  }
  const forge = fakeForge(files, { listing: true })
  const result = await analyzeFleet({
    group: 'acme',
    forgeId: 'work',
    repos: [{ forge: 'work', path: 'acme/mono' }],
    forge,
    registry: fakeRegistry({}),
    minRepos: 1,
    maxWorkspaces: 1,
  })
  expect(forge.listings).toEqual(['acme/mono:apps'])
  expect(result.notes).toEqual([])
  expect(result.repos[0]?.manifests).toEqual([
    'package.json',
    'apps/one/package.json',
    'go.mod',
    'services/a/go.mod',
  ])
  expect(result.libraries.map((library) => library.name)).toEqual(['github.com/acme/kit', 'react'])
})

test('selectLibraries ignores indirect usages when counting repositories', () => {
  expect(
    selectLibraries(
      [usage('a', 'indirect'), usage('b', 'indirect'), usage('c', 'prod')],
      [],
      2,
      10,
    ),
  ).toEqual([])
  expect(selectLibraries([usage('a', 'prod'), usage('b', 'prod')], [], 2, 10)).toHaveLength(1)
})

test('the analyzer runs through the forge with an injected registry', async () => {
  const analyzer = createFleetAnalyzer({ registry: () => fakeRegistry(latestVersions) })
  const options = analyzer.options.parse({ libraries: 'react, @acme/*', minRepos: '0' })
  expect(options.libraries).toEqual(['react', '@acme/*'])
  expect(analyzer.scope).toBe('group')
  const { data } = await analyzer.run({
    repo: { forge: 'work', path: 'acme' },
    repos: repos.slice(0, 4),
    forge: fakeGitForge(fleetFiles),
    runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) } as never,
    options,
  })
  expect(data.group).toBe('acme')
  expect(data.libraries.map((library) => library.name)).toEqual(['@acme/ui', 'react'])
})
