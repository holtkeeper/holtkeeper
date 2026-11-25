import { describe, expect, test } from 'bun:test'

import { diffDependencies, emptyDependencyDiff, renderDependencyDiff } from './index.ts'
import type { DependencyFilesReader } from './index.ts'

type Deps = Record<string, string>
interface Importer {
  name?: string
  dependencies?: Deps
  devDependencies?: Deps
}

function npmLock(importers: Record<string, Importer>, packages: Record<string, string>): string {
  const entries: Record<string, unknown> = {}
  for (const [path, importer] of Object.entries(importers)) entries[path] = importer
  for (const [name, version] of Object.entries(packages)) {
    const [pkg = name, deps] = name.split(' > ')
    entries[`node_modules/${pkg}`] = {
      version,
      ...(deps ? { dependencies: Object.fromEntries(deps.split(',').map((d) => [d, '*'])) } : {}),
    }
  }
  return JSON.stringify({ name: 'demo', lockfileVersion: 3, packages: entries })
}

function reader(
  sides: { from: Record<string, string>; to: Record<string, string> },
  reads: string[] = [],
): DependencyFilesReader {
  const paths = new Set([...Object.keys(sides.from), ...Object.keys(sides.to)])
  const files = [...paths]
    .filter((path) => sides.from[path] !== sides.to[path])
    .map((path) => ({
      oldPath: path,
      newPath: path,
      status:
        sides.from[path] === undefined
          ? 'added'
          : sides.to[path] === undefined
            ? 'deleted'
            : 'modified',
    }))
  return {
    files,
    read: async (path, side) => {
      reads.push(`${side}:${path}`)
      return sides[side][path]
    },
  }
}

const json = (value: unknown) => JSON.stringify(value)
const devLock = (version: string) =>
  npmLock({ '': { devDependencies: { 'some-lib': '^1.0.0' } } }, { 'some-lib': version })
const goMod = (lines: string) => `module example.com/foo\n\ngo 1.24\n\nrequire (\n${lines})\n`

describe('diffDependencies on npm roots', () => {
  test('reports direct and transitive changes of the root lockfile', async () => {
    const fromManifest = {
      dependencies: { 'some-lib': '^1.0.0', 'old-kit': '^2.0.0' },
      devDependencies: { 'test-kit': '^3.0.0' },
    }
    const toManifest = {
      dependencies: { 'some-lib': '^1.2.0', 'widget-kit': '^4.0.0' },
      devDependencies: { 'test-kit': '^3.0.0' },
    }
    const diff = await diffDependencies(
      reader({
        from: {
          'package.json': json(fromManifest),
          'package-lock.json': npmLock(
            { '': fromManifest },
            {
              'some-lib > tiny-dep': '1.0.4',
              'old-kit > gone-dep': '2.1.0',
              'test-kit': '3.0.0',
              'tiny-dep': '1.0.0',
              'gone-dep': '0.1.0',
            },
          ),
        },
        to: {
          'package.json': json(toManifest),
          'package-lock.json': npmLock(
            { '': toManifest },
            {
              'some-lib > tiny-dep': '1.2.1',
              'widget-kit > new-dep': '4.0.2',
              'test-kit': '3.0.0',
              'tiny-dep': '1.1.0',
              'new-dep': '5.0.0',
            },
          ),
        },
      }),
    )
    expect(diff.partial).toBe(false)
    expect(diff.skipped).toBe(0)
    expect(diff.roots).toHaveLength(1)
    const [root] = diff.roots
    expect(root).toMatchObject({
      path: '',
      ecosystem: 'npm',
      manager: 'npm',
      lockfile: 'package-lock.json',
      errors: [],
    })
    expect(root?.direct).toEqual([
      {
        name: 'old-kit',
        change: 'removed',
        field: 'prod',
        workspace: '.',
        from: { range: '^2.0.0', version: '2.1.0' },
      },
      {
        name: 'some-lib',
        change: 'updated',
        field: 'prod',
        workspace: '.',
        from: { range: '^1.0.0', version: '1.0.4' },
        to: { range: '^1.2.0', version: '1.2.1' },
      },
      {
        name: 'widget-kit',
        change: 'added',
        field: 'prod',
        workspace: '.',
        to: { range: '^4.0.0', version: '4.0.2' },
      },
    ])
    expect(root?.transitive).toEqual([
      { name: 'gone-dep', change: 'removed', from: ['0.1.0'] },
      { name: 'new-dep', change: 'added', to: ['5.0.0'] },
      { name: 'tiny-dep', change: 'updated', from: ['1.0.0'], to: ['1.1.0'] },
    ])
    expect(root?.counts).toEqual({
      added: 1,
      removed: 1,
      updated: 1,
      transitiveAdded: 1,
      transitiveRemoved: 1,
      transitiveUpdated: 1,
    })
  })

  test('reports lockfile-only re-resolutions of a direct dependency with its field', async () => {
    const manifest = json({ devDependencies: { 'some-lib': '^1.0.0' } })
    const diff = await diffDependencies(
      reader({
        from: { 'package.json': manifest, 'package-lock.json': devLock('1.0.0') },
        to: { 'package.json': manifest, 'package-lock.json': devLock('1.3.0') },
      }),
    )
    expect(diff.roots[0]?.direct).toEqual([
      {
        name: 'some-lib',
        change: 'updated',
        field: 'dev',
        workspace: '.',
        from: { range: '^1.0.0', version: '1.0.0' },
        to: { range: '^1.0.0', version: '1.3.0' },
      },
    ])
    expect(diff.roots[0]?.transitive).toEqual([])
  })

  test('puts a workspace manifest under the nearest lockfile root and skips workspace links', async () => {
    const lock = npmLock({ '': { name: 'demo' }, 'packages/app': { name: 'app' } }, {})
    const diff = await diffDependencies(
      reader({
        from: {
          'package.json': json({ workspaces: ['packages/*'] }),
          'package-lock.json': lock,
          'packages/app/package.json': json({ dependencies: { shared: 'workspace:*' } }),
        },
        to: {
          'package.json': json({ workspaces: ['packages/*'] }),
          'package-lock.json': lock,
          'packages/app/package.json': json({
            dependencies: { shared: 'workspace:^', 'some-lib': '^1.0.0' },
          }),
        },
      }),
    )
    expect(diff.roots).toHaveLength(1)
    expect(diff.roots[0]?.path).toBe('')
    expect(diff.roots[0]?.direct).toEqual([
      {
        name: 'some-lib',
        change: 'added',
        field: 'prod',
        workspace: 'packages/app',
        to: { range: '^1.0.0' },
      },
    ])
  })

  test('falls back to the manifest directory when no lockfile is found', async () => {
    const diff = await diffDependencies(
      reader({
        from: { 'tools/cli/package.json': json({}) },
        to: { 'tools/cli/package.json': json({ dependencies: { 'some-lib': '1.0.0' } }) },
      }),
    )
    expect(diff.roots[0]).toMatchObject({ path: 'tools/cli', ecosystem: 'npm', errors: [] })
    expect(diff.roots[0]?.manager).toBeUndefined()
    expect(diff.roots[0]?.direct).toHaveLength(1)
  })

  test('keeps what it knows when a lockfile does not parse or a read fails', async () => {
    const from = json({ dependencies: { 'some-lib': '^1.0.0' } })
    const to = json({ dependencies: { 'some-lib': '^2.0.0' } })
    const base = reader({
      from: { 'package.json': from, 'package-lock.json': '{ not json' },
      to: {
        'package.json': to,
        'package-lock.json': npmLock(
          { '': { dependencies: { 'some-lib': '^2.0.0' } } },
          { 'some-lib': '2.0.1' },
        ),
      },
    })
    const diff = await diffDependencies(base)
    const [root] = diff.roots
    expect(root?.errors).toHaveLength(1)
    expect(root?.errors[0]).toStartWith('package-lock.json could not be parsed at from')
    expect(root?.direct[0]).toMatchObject({
      change: 'updated',
      to: { range: '^2.0.0', version: '2.0.1' },
    })
    expect(root?.transitive).toEqual([])

    const failing = await diffDependencies({
      ...base,
      read: async (path, side) => {
        if (path === 'package.json' && side === 'from') throw new Error('timeout')
        return base.read(path, side)
      },
    })
    expect(failing.roots[0]?.errors).toContain('could not read package.json at from: timeout')
  })

  test('reads each file at most once per side', async () => {
    const reads: string[] = []
    await diffDependencies(
      reader(
        {
          from: {
            'a/package.json': json({}),
            'a/b/package.json': json({}),
            'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
          },
          to: {
            'a/package.json': json({ dependencies: { x: '1' } }),
            'a/b/package.json': json({ dependencies: { y: '1' } }),
            'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
          },
        },
        reads,
      ),
    )
    expect(reads.length).toBe(new Set(reads).size)
  })
})

describe('diffDependencies on Go modules', () => {
  test('reports go.mod requirements and selected go.sum modules, not go.mod-only hashes', async () => {
    const diff = await diffDependencies(
      reader({
        from: {
          'svc/go.mod': goMod(
            '\texample.com/bar v1.0.0\n\texample.com/old v0.3.0\n\texample.com/deep v0.1.0 // indirect\n',
          ),
          'svc/go.sum': [
            'example.com/bar v1.0.0 h1:a=',
            'example.com/old v0.3.0 h1:b=',
            'example.com/deep v0.1.0 h1:c=',
            'example.com/hidden v1.0.0 h1:d=',
            'example.com/hidden v1.0.0/go.mod h1:d=',
          ].join('\n'),
        },
        to: {
          'svc/go.mod': goMod(
            '\texample.com/bar v1.2.0\n\texample.com/new v2.0.0\n\texample.com/deep v0.2.0 // indirect\n',
          ),
          'svc/go.sum': [
            'example.com/bar v1.2.0 h1:a=',
            'example.com/new v2.0.0 h1:b=',
            'example.com/deep v0.2.0 h1:c=',
            'example.com/hidden v0.9.0/go.mod h1:d=',
            'example.com/hidden v1.1.0 h1:d=',
            'example.com/hidden v1.1.0/go.mod h1:d=',
            'example.com/fresh v0.0.1 h1:e=',
            'example.com/unselected v0.5.0/go.mod h1:f=',
          ].join('\n'),
        },
      }),
    )
    expect(diff.roots).toHaveLength(1)
    const [root] = diff.roots
    expect(root).toMatchObject({
      path: 'svc',
      ecosystem: 'go',
      manager: 'go',
      lockfile: 'go.sum',
      errors: [],
    })
    expect(root?.direct).toEqual([
      {
        name: 'example.com/bar',
        change: 'updated',
        field: 'require',
        workspace: 'example.com/foo',
        from: { version: 'v1.0.0' },
        to: { version: 'v1.2.0' },
      },
      {
        name: 'example.com/deep',
        change: 'updated',
        field: 'indirect',
        workspace: 'example.com/foo',
        from: { version: 'v0.1.0' },
        to: { version: 'v0.2.0' },
      },
      {
        name: 'example.com/new',
        change: 'added',
        field: 'require',
        workspace: 'example.com/foo',
        to: { version: 'v2.0.0' },
      },
      {
        name: 'example.com/old',
        change: 'removed',
        field: 'require',
        workspace: 'example.com/foo',
        from: { version: 'v0.3.0' },
      },
    ])
    expect(root?.transitive).toEqual([
      { name: 'example.com/fresh', change: 'added', to: ['v0.0.1'] },
      { name: 'example.com/hidden', change: 'updated', from: ['v1.0.0'], to: ['v1.1.0'] },
    ])
  })
})

describe('diffDependencies limits', () => {
  test('skips vendored paths, caps roots, passes on partial and sorts roots', async () => {
    const files = ['b', 'a', 'c'].map((dir) => `${dir}/go.mod`)
    const diff = await diffDependencies({
      files: [...files, 'vendor/x/go.mod', 'web/node_modules/y/package.json'].map((path) => ({
        oldPath: path,
        newPath: path,
        status: 'modified',
      })),
      read: async (path, side) =>
        path.endsWith('go.mod')
          ? `module example.com/${path}\nrequire example.com/dep v1.0.${side === 'from' ? 0 : 1}\n`
          : undefined,
      maxRoots: 2,
      partial: true,
    })
    expect(diff.roots.map((root) => root.path)).toEqual(['a', 'b'])
    expect(diff.skipped).toBe(1)
    expect(diff.partial).toBe(true)
  })

  test('leaves out roots without changes', async () => {
    const diff = await diffDependencies(
      reader({
        from: { 'package.json': json({ scripts: { a: '1' } }) },
        to: { 'package.json': json({ scripts: { a: '2' } }) },
      }),
    )
    expect(diff).toEqual(emptyDependencyDiff())
  })
})

describe('renderDependencyDiff', () => {
  test('is empty without roots', () => {
    expect(renderDependencyDiff(emptyDependencyDiff())).toBe('')
  })

  test('renders counts, direct changes and a transitive sample', () => {
    const text = renderDependencyDiff(
      {
        roots: [
          {
            path: 'web',
            ecosystem: 'npm',
            manager: 'pnpm',
            lockfile: 'pnpm-lock.yaml',
            direct: [
              {
                name: 'some-lib',
                change: 'updated',
                field: 'prod',
                workspace: '.',
                from: { range: '^1.0.0', version: '1.0.0' },
                to: { range: '^2.0.0', version: '2.0.1' },
              },
              {
                name: 'widget-kit',
                change: 'added',
                field: 'dev',
                workspace: 'packages/app',
                to: { range: '^3.0.0', version: '3.0.0' },
              },
            ],
            transitive: [
              { name: 'tiny-dep', change: 'updated', from: ['1.0.0'], to: ['1.1.0'] },
              { name: 'new-dep', change: 'added', to: ['5.0.0'] },
            ],
            counts: {
              added: 1,
              removed: 0,
              updated: 1,
              transitiveAdded: 1,
              transitiveRemoved: 0,
              transitiveUpdated: 1,
            },
            errors: [],
          },
        ],
        skipped: 2,
        partial: true,
      },
      { maxTransitive: 1 },
    )
    expect(text).toBe(
      [
        '### web/pnpm-lock.yaml (pnpm)',
        'Direct: 1 added, 1 updated, 0 removed. Transitive: 1 added, 1 updated, 0 removed.',
        '- `some-lib` ^1.0.0 (1.0.0) → ^2.0.0 (2.0.1) (prod)',
        '- added `widget-kit` ^3.0.0 (3.0.0) (dev, packages/app)',
        'Transitive: tiny-dep 1.0.0 → 1.1.0; … 1 more',
        '',
        '2 more dependency roots were not computed. The changed file list was incomplete; some roots may be missing.',
      ].join('\n'),
    )
  })
})
