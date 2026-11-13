import { describe, expect, test } from 'bun:test'

import {
  addedInterfaceMethods,
  declaredMembers,
  findSites,
  packageUsage,
  upgradeImpact,
  usedByCounts,
} from './fleet.ts'
import type { UsageSite, UsagesData, UsedExport } from './model.ts'
import { impactNotes, renderImpact, renderPackageUsage, renderSites } from './render.ts'

const site = (file: string, extra: Partial<UsageSite> = {}): UsageSite => ({
  file,
  line: 3,
  column: 5,
  kind: 'jsx',
  snippet: '<Button />',
  snippetLine: 1,
  ...extra,
})

const used = (name: string, sites: UsageSite[], extra: Partial<UsedExport> = {}): UsedExport => {
  const props = new Map<string, number>()
  const members = new Map<string, number>()
  for (const item of sites) {
    for (const prop of item.props ?? []) props.set(prop, (props.get(prop) ?? 0) + 1)
    if (item.member) members.set(item.member, (members.get(item.member) ?? 0) + 1)
  }
  return {
    name,
    subpath: '.',
    count: sites.length,
    files: new Set(sites.map((s) => s.file)).size,
    kinds: { [sites[0]?.kind ?? 'reference']: sites.length },
    members: [...members].map(([n, count]) => ({ name: n, count })),
    props: [...props].map(([n, count]) => ({ name: n, count })),
    spread: 0,
    sites,
    ...extra,
  }
}

const record = (version: string, exports: UsedExport[]): UsagesData => ({
  packages: [
    {
      name: '@acme/ui',
      versions: [version],
      ranges: [`^${version}`],
      workspaces: ['root'],
      count: exports.reduce((sum, item) => sum + item.count, 0),
      files: 1,
      exports,
    },
  ],
  files: 10,
  types: { status: 'used', sites: 0 },
})

const entries = [
  {
    origin: 'gitlab:games/tetra',
    data: record('3.2.1', [
      used('Button', [
        site('src/menu.tsx', { props: ['variant', 'size'] }),
        site('src/hud.tsx', { props: ['variant'] }),
      ]),
      used('useStore', [site('src/game.ts', { kind: 'call', member: '().reset' })]),
    ]),
  },
  {
    origin: 'gitlab:games/snake',
    data: record('2.9.0', [used('Button', [site('src/app.tsx', { props: ['onPress'] })])]),
  },
  { origin: 'gitlab:games/chess', data: { ...record('1.0.0', []), packages: [] } },
]

describe('packageUsage', () => {
  test('sums exports, props and versions across repositories', () => {
    const usage = packageUsage(entries, '@acme/ui')
    expect(usage.versions).toEqual(['3.2.1', '2.9.0'])
    expect(usage.repos.map((r) => r.origin)).toEqual(['gitlab:games/tetra', 'gitlab:games/snake'])
    const [button] = usage.exports
    expect(button).toMatchObject({
      name: 'Button',
      count: 3,
      repos: ['gitlab:games/tetra', 'gitlab:games/snake'],
    })
    expect(button?.props).toEqual([
      { name: 'variant', count: 2 },
      { name: 'onPress', count: 1 },
      { name: 'size', count: 1 },
    ])
    expect(renderPackageUsage(usage, { originLabel: String })).toContain('props: `variant` ×2')
  })
})

describe('findSites', () => {
  test('narrows by export, prop and member', () => {
    expect(
      findSites(entries, { package: '@acme/ui', prop: 'variant' }).sites.map((s) => s.site.file),
    ).toEqual(['src/menu.tsx', 'src/hud.tsx'])
    const reset = findSites(entries, { package: '@acme/ui', member: 'reset' })
    expect(reset.sites).toHaveLength(1)
    expect(reset.sites[0]).toMatchObject({
      origin: 'gitlab:games/tetra',
      export: 'useStore',
      versions: ['3.2.1'],
    })
    expect(findSites(entries, { package: '@acme/ui', export: 'Button', limit: 1 })).toMatchObject({
      total: 3,
      more: 2,
    })
    expect(renderSites(reset)).toContain('`src/game.ts:3` — call `.().reset`')
  })
})

describe('upgradeImpact', () => {
  test('finds removed exports and props a changed type no longer has', () => {
    const impact = upgradeImpact({
      entries,
      package: '@acme/ui',
      changes: [
        {
          change: 'changed',
          subpath: '.',
          name: 'ButtonProps',
          kind: 'interface',
          before:
            'interface ButtonProps {\n  variant?: string\n  size?: number\n  onPress?: () => void\n}',
          after: 'interface ButtonProps {\n  tone?: string\n  onPress?: () => void\n}',
        },
        { change: 'removed', subpath: '.', name: 'useStore', kind: 'function' },
        { change: 'added', subpath: '.', name: 'Toast' },
      ],
      declarations: new Map([['Button', 'function Button(props: ButtonProps): JSX.Element']]),
    })
    expect(impact.items.map((item) => `${item.level}:${item.change.name}:${item.count}`)).toEqual([
      'breaking:ButtonProps:3',
      'breaking:useStore:1',
    ])
    const [props] = impact.items
    expect(props?.removedMembers).toEqual(['variant', 'size'])
    expect(props?.repos).toEqual([
      expect.objectContaining({
        origin: 'gitlab:games/tetra',
        via: 'Button',
        members: ['variant', 'size'],
        count: 3,
      }),
    ])
    expect(impact.affected).toEqual(['gitlab:games/tetra'])
    expect(impact.unaffected).toEqual(['gitlab:games/snake'])
    expect(renderImpact(impact)).toContain('## breaking: removed `@acme/ui` → useStore (1 uses)')
  })
})

describe('declaredMembers', () => {
  test('lists top-level members of a declaration', () => {
    expect([
      ...declaredMembers(
        'interface A {\n  a: string\n  readonly b?: number\n  c(): void\n  d: { e: 1 }\n}',
      ),
    ]).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('usedByCounts', () => {
  test('sums repositories, uses and files per name and keeps unused names at zero', () => {
    const counts = usedByCounts(entries, ['@acme/ui', '@acme/unused'])
    const usage = packageUsage(entries, '@acme/ui')
    expect(counts.get('@acme/ui')).toEqual({
      repos: usage.repos.length,
      count: usage.repos.reduce((sum, repo) => sum + repo.count, 0),
      files: usage.repos.reduce((sum, repo) => sum + repo.files, 0),
    })
    expect(counts.get('@acme/unused')).toEqual({ repos: 0, count: 0, files: 0 })
  })
})

const goRecord = (version: string, exports: UsedExport[]): UsagesData => ({
  packages: [
    {
      name: 'gitlab.example/shapes/libs/geom',
      ecosystem: 'Go',
      versions: [version],
      ranges: [version],
      workspaces: ['example.com/acme/widgets'],
      count: exports.reduce((sum, item) => sum + item.count, 0),
      files: 2,
      exports,
    },
  ],
  files: 4,
  types: { status: 'skipped', reason: 'go: syntactic only' },
})

const goSite = (file: string, kind: UsageSite['kind'], extra: Partial<UsageSite> = {}) =>
  site(file, { kind, snippet: 'geom.Rect{Min: p}', ...extra })

const goEntries = [
  {
    origin: 'gitlab:shapes/editor',
    data: goRecord('v1.4.0', [
      used('Rect', [
        goSite('draw.go', 'new', { props: ['Min', 'Max'] }),
        goSite('draw.go', 'member', { member: 'Area' }),
      ]),
      used('NewPoint', [goSite('main.go', 'call')]),
      used('Cells', [goSite('grid.go', 'call')], { subpath: './grid' }),
    ]),
  },
  {
    origin: 'gitlab:shapes/viewer',
    data: goRecord('v1.2.0', [used('Cells', [goSite('view.go', 'call')], { subpath: './grid' })]),
  },
]

describe('Go usage records', () => {
  test('packageUsage takes a module path for every package and an import path for one', () => {
    const module = packageUsage(goEntries, 'gitlab.example/shapes/libs/geom')
    expect(module).toMatchObject({ name: 'gitlab.example/shapes/libs/geom', ecosystem: 'Go' })
    expect(module.subpath).toBeUndefined()
    expect(module.repos.map((repo) => repo.origin)).toEqual([
      'gitlab:shapes/editor',
      'gitlab:shapes/viewer',
    ])

    const grid = packageUsage(goEntries, 'gitlab.example/shapes/libs/geom/grid')
    expect(grid).toMatchObject({
      name: 'gitlab.example/shapes/libs/geom',
      ecosystem: 'Go',
      subpath: './grid',
      versions: ['v1.4.0', 'v1.2.0'],
    })
    expect(grid.exports.map((item) => `${item.subpath} ${item.name} ${item.count}`)).toEqual([
      './grid Cells 2',
    ])
    expect(grid.repos.map((repo) => repo.count)).toEqual([1, 1])
    expect(renderPackageUsage(grid, { originLabel: String })).toContain(
      '# gitlab.example/shapes/libs/geom/grid (Go): 2 repositories',
    )
    expect(packageUsage(goEntries, 'gitlab.example/shapes/libs/geometry').repos).toEqual([])
  })

  test('a module path without /vN counts every major of the module', () => {
    const v2 = goRecord('v2.1.0', [used('Rect', [goSite('pane.go', 'new')])])
    const [pkg] = v2.packages
    if (!pkg) throw new Error('fixture')
    const both: UsagesData = {
      ...v2,
      packages: [
        { ...pkg, name: 'gitlab.example/shapes/libs/geom/v2' },
        ...goRecord('v1.4.0', [used('NewPoint', [goSite('old.go', 'call')])]).packages,
      ],
    }
    const majors = [
      {
        origin: 'gitlab:shapes/panes',
        data: { ...v2, packages: [{ ...pkg, name: 'gitlab.example/shapes/libs/geom/v2' }] },
      },
      { origin: 'gitlab:shapes/mixed', data: both },
    ]
    const usage = packageUsage(majors, 'gitlab.example/shapes/libs/geom')
    expect(usage).toMatchObject({ ecosystem: 'Go', versions: ['v2.1.0', 'v1.4.0'] })
    expect(usage.repos.map((repo) => [repo.origin, repo.versions])).toEqual([
      ['gitlab:shapes/mixed', ['v2.1.0', 'v1.4.0']],
      ['gitlab:shapes/panes', ['v2.1.0']],
    ])
    expect(usage.exports.map((item) => item.name).toSorted()).toEqual(['NewPoint', 'Rect'])
    expect(findSites(majors, { package: 'gitlab.example/shapes/libs/geom' }).total).toBe(3)
  })

  test('findSites narrows a Go import path to its package', () => {
    const found = findSites(goEntries, { package: 'gitlab.example/shapes/libs/geom/grid' })
    expect(found.sites.map((item) => `${item.origin} ${item.export} ${item.site.file}`)).toEqual([
      'gitlab:shapes/editor Cells grid.go',
      'gitlab:shapes/viewer Cells view.go',
    ])
    expect(renderSites(found)).toContain('```go')
    expect(findSites(goEntries, { package: 'gitlab.example/shapes/libs/geom' }).total).toBe(5)
  })

  test('upgradeImpact matches the package by import path, method symbols and struct fields', () => {
    const impact = upgradeImpact({
      entries: goEntries,
      package: 'gitlab.example/shapes/libs/geom',
      changes: [
        { change: 'removed', subpath: '.', name: 'Rect.Area', kind: 'function' },
        {
          change: 'changed',
          subpath: '.',
          name: 'Rect',
          kind: 'type',
          before: 'type Rect struct {\n\tMin, Max Point\n\tLabel string // shown\n}',
          after: 'type Rect struct {\n\tMin Point\n\tLabel string\n}',
        },
        { change: 'removed', subpath: '.', name: 'Cells', kind: 'function' },
      ],
    })
    expect(impact.ecosystem).toBe('Go')
    expect(impact.items.map((item) => `${item.level}:${item.change.name}:${item.count}`)).toEqual([
      'breaking:Rect.Area:1',
      'breaking:Rect:1',
    ])
    expect(impact.items[0]?.repos[0]).toMatchObject({
      origin: 'gitlab:shapes/editor',
      members: ['Area'],
    })
    expect(impact.items[1]?.removedMembers).toEqual(['Max'])
    expect(impact.unaffected).toEqual([])
    expect(renderImpact(impact)).toContain('```go')

    const grid = upgradeImpact({
      entries: goEntries,
      package: 'gitlab.example/shapes/libs/geom/grid',
      changes: [{ change: 'removed', subpath: '.', name: 'Cells', kind: 'function' }],
    })
    expect(grid.items.map((item) => `${item.level}:${item.count}`)).toEqual(['breaking:2'])
    expect(grid.affected.toSorted()).toEqual(['gitlab:shapes/editor', 'gitlab:shapes/viewer'])
  })

  test('addedInterfaceMethods finds methods an interface only gains', () => {
    const before = 'type Drawer interface {\n\tfmt.Stringer\n\tDraw(c Canvas) error\n}'
    expect(
      addedInterfaceMethods(
        before,
        'type Drawer interface {\n\tfmt.Stringer\n\tDraw(c Canvas) error\n\t// Bounds of the shape.\n\tBounds() Rect\n}',
      ),
    ).toEqual(['Bounds'])
    expect(
      addedInterfaceMethods(
        before,
        'type Drawer interface {\n\tfmt.Stringer\n\tDraw(c Canvas, scale int) error\n\tBounds() Rect\n}',
      ),
    ).toEqual([])
    expect(
      addedInterfaceMethods(
        'type Rect struct {\n\tMin Point\n}',
        'type Rect struct {\n\tMin Point\n\tMax Point\n}',
      ),
    ).toEqual([])
  })

  test('an interface that only gains methods breaks no use and is reported as widened', () => {
    const drawerUse = used('Drawer', [
      goSite('paint.go', 'type'),
      goSite('paint.go', 'call', { member: 'Draw' }),
    ])
    const typed = goRecord('v1.4.0', [drawerUse])
    const drawers = [
      {
        origin: 'gitlab:shapes/editor',
        data: { ...typed, types: { status: 'used' as const, sites: 3 } },
      },
      { origin: 'gitlab:shapes/viewer', data: goRecord('v1.4.0', [drawerUse]) },
    ]
    const impact = upgradeImpact({
      entries: drawers,
      package: 'gitlab.example/shapes/libs/geom',
      changes: [
        {
          change: 'changed',
          subpath: '.',
          name: 'Drawer',
          kind: 'type',
          before: 'type Drawer interface {\n\tDraw(c Canvas) error\n}',
          after: 'type Drawer interface {\n\tDraw(c Canvas) error\n\tBounds() Rect\n}',
        },
      ],
    })
    expect(impact.items).toEqual([])
    expect(impact.affected).toEqual([])
    expect(impact.widened).toEqual([
      {
        name: 'Drawer',
        subpath: '.',
        members: ['Bounds'],
        repos: ['gitlab:shapes/editor', 'gitlab:shapes/viewer'],
      },
    ])
    expect(impact.untyped).toEqual([
      { origin: 'gitlab:shapes/viewer', reason: 'go: syntactic only' },
    ])
    expect(impactNotes(impact)).toEqual([
      '`gitlab.example/shapes/libs/geom`.Drawer gains `Bounds`: no use of it breaks, but types implementing it outside the library must add it; implementations are not visible here. 2 repositories use it.',
      'Go call sites in `gitlab:shapes/viewer` (go: syntactic only) were read without types: methods called on values the package returns are not seen there.',
    ])
    expect(renderImpact(impact)).toContain(
      'No analyzed use of gitlab.example/shapes/libs/geom is affected',
    )
    expect(renderImpact(impact)).toContain('Drawer gains `Bounds`')
  })

  test('declaredMembers lists Go struct fields, embeds and interface methods', () => {
    expect([
      ...declaredMembers(
        'type Shape struct {\n\tName, Tag string `json:"name"`\n\t*geom.Base\n\tSides int\n\t// Hidden note\n}',
      ),
    ]).toEqual(['Name', 'Tag', 'Base', 'Sides'])
    expect([
      ...declaredMembers('type Drawer interface {\n\tfmt.Stringer\n\tDraw(c Canvas) error\n}'),
    ]).toEqual(['Stringer', 'Draw'])
  })
})
