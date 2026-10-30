import { describe, expect, test } from 'bun:test'

import { declaredMembers, findSites, packageUsage, upgradeImpact } from './fleet.ts'
import type { UsageSite, UsagesData, UsedExport } from './model.ts'
import { renderImpact, renderPackageUsage, renderSites } from './render.ts'

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
