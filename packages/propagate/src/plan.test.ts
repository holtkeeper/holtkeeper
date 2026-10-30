import { describe, expect, test } from 'bun:test'

import { fakeForge, fakeRegistry } from '../test/fakes.ts'
import { createPlanner, forgeFiles } from './plan.ts'
import { resolveTargets } from './registry.ts'

const files = {
  'games/a': {
    'package.json': JSON.stringify({
      workspaces: ['packages/*', 'tools/cli'],
      dependencies: { '@acme/ui': '^1.2.0' },
    }),
    'packages/web/package.json': JSON.stringify({ dependencies: { '@acme/ui': 'catalog:' } }),
    'packages/web/node_modules/x/package.json': JSON.stringify({
      dependencies: { '@acme/ui': '0.1.0' },
    }),
    'packages/api/package.json': JSON.stringify({ devDependencies: { '@acme/ui': '~1.0.0' } }),
    'tools/cli/package.json': JSON.stringify({ dependencies: { left: '1.0.0' } }),
    'pnpm-workspace.yaml': 'catalog:\n  "@acme/ui": ^1.1.0\n',
  },
  'games/b': {
    'package.json': JSON.stringify({ dependencies: { '@acme/ui': '^2.0.0' } }),
  },
  'svc/go': {
    'go.work': 'go 1.22\n\nuse (\n\t.\n\t./worker\n)\n',
    'go.mod': 'module example.com/svc\n\nrequire example.com/lib v1.0.0\n',
    'worker/go.mod': 'module example.com/svc/worker\n\nrequire example.com/lib v1.5.0\n',
  },
}

describe('planner', () => {
  test('resolves latest through the registry', async () => {
    const targets = await resolveTargets(
      [
        { name: '@acme/ui', version: 'latest' },
        { name: 'example.com/lib', version: '1.5.0', ecosystem: 'Go' },
      ],
      fakeRegistry({ 'npm:@acme/ui': '2.0.0' }),
    )
    expect(targets).toEqual([
      { name: '@acme/ui', ecosystem: 'npm', requested: 'latest', version: '2.0.0' },
      { name: 'example.com/lib', ecosystem: 'Go', requested: '1.5.0', version: 'v1.5.0' },
    ])
    const failure = await resolveTargets([{ name: 'x', version: 'latest' }], fakeRegistry({})).then(
      () => '',
      (error: unknown) => String(error),
    )
    expect(failure).toContain('cannot resolve')
  })

  test('reads root, workspaces, catalogs and go.work modules through the forge', async () => {
    const { forge } = fakeForge(files)
    const targets = await resolveTargets([
      { name: '@acme/ui', version: '2.0.0' },
      { name: 'example.com/lib', version: 'v1.5.0', ecosystem: 'Go' },
    ])
    const planner = createPlanner()
    const a = await planner.plan(forgeFiles(forge, 'games/a'), targets)
    expect(
      a.usages.map((u) => [u.manifest, u.path.join('.'), u.declared, u.next ?? u.note]),
    ).toEqual([
      ['package.json', 'dependencies.@acme/ui', '^1.2.0', '^2.0.0'],
      ['pnpm-workspace.yaml', 'catalog.@acme/ui', '^1.1.0', '^2.0.0'],
      ['packages/api/package.json', 'devDependencies.@acme/ui', '~1.0.0', '~2.0.0'],
      [
        'packages/web/package.json',
        'dependencies.@acme/ui',
        'catalog:',
        'version comes from catalog "default"',
      ],
    ])
    const b = await planner.plan(forgeFiles(forge, 'games/b'), targets)
    expect(b.usages.every((usage) => usage.next === undefined)).toBe(true)
    const go = await planner.plan(forgeFiles(forge, 'svc/go'), targets)
    expect(go.usages.map((u) => [u.manifest, u.next])).toEqual([
      ['go.mod', 'v1.5.0'],
      ['worker/go.mod', undefined],
    ])
  })

  test('notes globs it cannot expand without listing', async () => {
    const { forge } = fakeForge(files)
    const targets = await resolveTargets([{ name: '@acme/ui', version: '2.0.0' }])
    const plan = await createPlanner().plan(
      { read: (file) => forge.readFile('games/a', file) },
      targets,
    )
    expect(plan.notes).toEqual([
      'workspace pattern "packages/*" cannot be expanded without file listing; skipped',
    ])
    expect(plan.usages).toHaveLength(2)
  })
})
