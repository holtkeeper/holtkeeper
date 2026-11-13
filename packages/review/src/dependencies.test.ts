import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { DiffFile } from '@holtkeeper/forge'

import {
  DEPENDENCY_SECTION_MAX_CHARS,
  DEPENDENCY_SECTION_TITLE,
  dependencySection,
} from './dependencies.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type Tree = Record<string, string>

async function section(head: Tree, base: Tree, changed: (string | Partial<DiffFile>)[]) {
  const dir = await mkdtemp(join(tmpdir(), 'review-deps-'))
  dirs.push(dir)
  await Promise.all(
    Object.entries(head).map(async ([path, text]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), text)
    }),
  )
  const files = changed.map((file): DiffFile =>
    typeof file === 'string'
      ? { oldPath: file, newPath: file, status: 'modified', diff: '' }
      : { oldPath: '', newPath: '', status: 'modified', diff: '', ...file },
  )
  return dependencySection({ files, dir, readBase: async (path) => base[path] })
}

const manifest = (dependencies: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ name: 'shapes-app', version: '1.0.0', dependencies, ...extra }, null, 2)

/** A package-lock.json v3 of a single package with `dependencies` and resolved `packages`. */
function npmLock(dependencies: Record<string, string>, packages: Record<string, string>) {
  return JSON.stringify({
    name: 'shapes-app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'shapes-app', version: '1.0.0', dependencies },
      ...Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [
          `node_modules/${name}`,
          { version, resolved: `https://registry.example.com/${name}-${version}.tgz` },
        ]),
      ),
    },
  })
}

const yarnClassic = (entries: Record<string, string>) =>
  [
    '# yarn lockfile v1',
    '',
    ...Object.entries(entries).flatMap(([descriptor, version]) => [
      `${descriptor}:`,
      `  version "${version}"`,
      '',
    ]),
  ].join('\n')

const berry = (dependencies: Record<string, string>, packages: Record<string, string>) =>
  [
    '__metadata:',
    '  version: 8',
    '',
    '"shapes-app@workspace:.":',
    '  version: 0.0.0-use.local',
    '  resolution: "shapes-app@workspace:."',
    '  dependencies:',
    ...Object.entries(dependencies).map(([name, range]) => `    ${name}: "npm:${range}"`),
    '  languageName: unknown',
    '  linkType: soft',
    '',
    ...Object.entries(packages).flatMap(([descriptor, version]) => [
      `"${descriptor}":`,
      `  version: ${version}`,
      `  resolution: "${descriptor.slice(0, descriptor.indexOf('@npm:'))}@npm:${version}"`,
      '  languageName: node',
      '  linkType: hard',
      '',
    ]),
  ].join('\n')

const pnpm = (dependencies: Record<string, [string, string]>) =>
  [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '  .:',
    '    dependencies:',
    ...Object.entries(dependencies).flatMap(([name, [specifier, version]]) => [
      `      ${name}:`,
      `        specifier: ${specifier}`,
      `        version: ${version}`,
    ]),
    '',
    'packages:',
    ...Object.values(dependencies).map(([, version], i) => `  pkg${i}@${version}: {}`),
    '',
    'snapshots:',
    ...Object.entries(dependencies).map(([name, [, version]]) => `  ${name}@${version}: {}`),
  ].join('\n')

const bunLock = (dependencies: Record<string, string>, packages: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 1,
    workspaces: { '': { name: 'shapes-app', dependencies } },
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, version]) => [
        name,
        [`${name}@${version}`, '', {}, 'sha512-x'],
      ]),
    ),
  })

const goMod = (requires: string[]) =>
  `module example.com/shapes\n\ngo 1.23\n\nrequire (\n${requires.map((r) => `\t${r}`).join('\n')}\n)\n`

describe('npm', () => {
  test('an added dependency present in the lockfile is reported as consistent', async () => {
    const text = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' }),
        'package-lock.json': npmLock(
          { 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' },
          { 'color-kit': '2.3.0', 'left-widget': '1.0.4' },
        ),
      },
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'package-lock.json': npmLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '2.3.0' }),
      },
      [
        'package.json',
        { newPath: 'package-lock.json', oldPath: 'package-lock.json', binary: true },
      ],
    )
    expect(text).toStartWith(`## ${DEPENDENCY_SECTION_TITLE}`)
    expect(text).toContain('### package-lock.json (npm)')
    expect(text).toContain(
      '- package.json: added dependencies `left-widget` ^1.0.0, lockfile resolves 1.0.4',
    )
    expect(text).toContain('- direct, added: left-widget 1.0.4')
    expect(text).toContain(
      'Consistency: OK. package-lock.json resolves all 2 registry dependencies',
    )
    expect(text).not.toContain('Consistency problems')
  })

  test('a dependency missing from the lockfile is flagged', async () => {
    const lock = npmLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '2.3.0' })
    const text = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' }),
        'package-lock.json': lock,
      },
      { 'package.json': manifest({ 'color-kit': '^2.1.0' }), 'package-lock.json': lock },
      ['package.json'],
    )
    expect(text).toContain('package-lock.json: not changed by this merge request')
    expect(text).toContain('added dependencies `left-widget` ^1.0.0, not resolved by the lockfile')
    expect(text).toContain(
      '- package.json declares `left-widget` ^1.0.0 (dependencies), but package-lock.json does not resolve it',
    )
    expect(text).not.toContain('Consistency: OK')
  })

  test('a range bump the lockfile did not follow is flagged', async () => {
    const lock = npmLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '2.3.0' })
    const text = await section(
      { 'package.json': manifest({ 'color-kit': '^3.0.0' }), 'package-lock.json': lock },
      { 'package.json': manifest({ 'color-kit': '^2.1.0' }), 'package-lock.json': lock },
      ['package.json'],
    )
    expect(text).toContain('dependencies `color-kit` ^2.1.0 → ^3.0.0, lockfile 2.3.0')
    expect(text).toContain('declares `color-kit` ^3.0.0, but package-lock.json recorded ^2.1.0')
  })

  test('a version bump in the lockfile is listed with the old and new version', async () => {
    const text = await section(
      {
        'package.json': manifest({ 'color-kit': '^3.0.0' }),
        'package-lock.json': npmLock(
          { 'color-kit': '^3.0.0' },
          { 'color-kit': '3.0.1', 'hue-math': '1.1.0' },
        ),
      },
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'package-lock.json': npmLock(
          { 'color-kit': '^2.1.0' },
          { 'color-kit': '2.3.0', 'hue-math': '1.0.0' },
        ),
      },
      ['package.json', 'package-lock.json'],
    )
    expect(text).toContain('dependencies `color-kit` ^2.1.0 → ^3.0.0, lockfile 2.3.0 → 3.0.1')
    expect(text).toContain('- direct, changed: color-kit 2.3.0 → 3.0.1')
    expect(text).toContain('- transitive, changed (1): hue-math 1.0.0 → 1.1.0')
    expect(text).toContain('Consistency: OK.')
  })

  test('a lockfile-only change marked binary in the diff is still computed', async () => {
    const text = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'package-lock.json': npmLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '2.4.0' }),
      },
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'package-lock.json': npmLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '2.3.0' }),
      },
      [{ newPath: 'package-lock.json', oldPath: 'package-lock.json', binary: true, diff: '' }],
    )
    expect(text).toContain('package-lock.json: changed by this merge request')
    expect(text).toContain('- (root): `color-kit` 2.3.0 → 2.4.0')
    expect(text).toContain('Consistency: OK.')
  })

  test('workspaces resolve against the root lockfile', async () => {
    const text = await section(
      {
        'package.json': JSON.stringify({ name: 'shapes-root', workspaces: ['packages/*'] }),
        'packages/circle/package.json': JSON.stringify({
          name: '@shapes/circle',
          dependencies: { '@shapes/core': 'workspace:*', 'color-kit': '^2.0.0' },
        }),
        'packages/core/package.json': JSON.stringify({ name: '@shapes/core' }),
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'shapes-root', workspaces: ['packages/*'] },
            'packages/circle': {
              name: '@shapes/circle',
              dependencies: { '@shapes/core': 'workspace:*', 'color-kit': '^2.0.0' },
            },
            'packages/core': { name: '@shapes/core' },
            'node_modules/@shapes/circle': { resolved: 'packages/circle', link: true },
            'node_modules/@shapes/core': { resolved: 'packages/core', link: true },
            'node_modules/color-kit': { version: '2.3.0' },
          },
        }),
      },
      {},
      ['packages/circle/package.json'],
    )
    expect(text).toContain('### package-lock.json (npm)')
    expect(text).toContain(
      '- packages/circle/package.json: added dependencies `color-kit` ^2.0.0, lockfile resolves 2.3.0',
    )
    expect(text).toContain('Consistency: OK.')
  })

  test('the lockfile still listing a removed dependency is an out-of-sync signal', async () => {
    const lock = npmLock(
      { 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' },
      { 'color-kit': '2.3.0', 'left-widget': '1.0.4' },
    )
    const text = await section(
      { 'package.json': manifest({ 'color-kit': '^2.1.0' }), 'package-lock.json': lock },
      {
        'package.json': manifest({ 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' }),
        'package-lock.json': lock,
      },
      ['package.json'],
    )
    expect(text).toContain('removed dependencies `left-widget` ^1.0.0')
    expect(text).toContain(
      'package-lock.json still records `left-widget` ^1.0.0 for package.json, which no longer declares it',
    )
  })
})

describe('other package managers', () => {
  test('yarn classic: a descriptor missing from yarn.lock is flagged', async () => {
    const text = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' }),
        'yarn.lock': yarnClassic({ 'color-kit@^2.1.0': '2.3.0', 'left-widget@^0.9.0': '0.9.2' }),
      },
      {},
      ['package.json'],
    )
    expect(text).toContain('### yarn.lock (yarn)')
    expect(text).toContain(
      'declares `left-widget` ^1.0.0 (dependencies), but yarn.lock does not resolve it',
    )
    expect(text).not.toContain('color-kit` ^2.1.0 (dependencies), but')
  })

  test('yarn classic: a present descriptor is consistent', async () => {
    const text = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'yarn.lock': yarnClassic({ 'color-kit@^2.1.0': '2.3.0' }),
      },
      {},
      ['package.json', 'yarn.lock'],
    )
    expect(text).toContain('Consistency: OK. yarn.lock resolves all 1 registry dependencies')
  })

  test('yarn berry: matching ranges are consistent, a stale range is flagged', async () => {
    const lock = berry({ 'color-kit': '^2.1.0' }, { 'color-kit@npm:^2.1.0': '2.3.0' })
    const ok = await section(
      { 'package.json': manifest({ 'color-kit': '^2.1.0' }), 'yarn.lock': lock },
      {},
      ['package.json'],
    )
    expect(ok).toContain('Consistency: OK.')
    const stale = await section(
      { 'package.json': manifest({ 'color-kit': '^2.2.0' }), 'yarn.lock': lock },
      {},
      ['package.json'],
    )
    expect(stale).toContain('declares `color-kit` ^2.2.0, but yarn.lock recorded npm:^2.1.0')
  })

  test('pnpm: added dependency present, missing one flagged', async () => {
    const lock = pnpm({ 'color-kit': ['^2.1.0', '2.3.0'] })
    const ok = await section(
      { 'package.json': manifest({ 'color-kit': '^2.1.0' }), 'pnpm-lock.yaml': lock },
      { 'package.json': manifest({}) },
      ['package.json', 'pnpm-lock.yaml'],
    )
    expect(ok).toContain('### pnpm-lock.yaml (pnpm)')
    expect(ok).toContain('added dependencies `color-kit` ^2.1.0, lockfile resolves 2.3.0')
    expect(ok).toContain('Consistency: OK.')
    const missing = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0', 'left-widget': '^1.0.0' }),
        'pnpm-lock.yaml': lock,
      },
      {},
      ['package.json'],
    )
    expect(missing).toContain(
      '`left-widget` ^1.0.0 (dependencies), but pnpm-lock.yaml does not resolve it',
    )
  })

  test('bun: a resolution outside the declared range is flagged', async () => {
    const ok = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'bun.lock': bunLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '2.3.0' }),
      },
      {},
      ['package.json'],
    )
    expect(ok).toContain('### bun.lock (bun)')
    expect(ok).toContain('Consistency: OK.')
    const outside = await section(
      {
        'package.json': manifest({ 'color-kit': '^2.1.0' }),
        'bun.lock': bunLock({ 'color-kit': '^2.1.0' }, { 'color-kit': '1.9.0' }),
      },
      {},
      ['bun.lock'],
    )
    expect(outside).toContain('bun.lock resolves `color-kit` to 1.9.0, outside the range ^2.1.0')
  })

  test('a package.json without any lockfile says so', async () => {
    const text = await section({ 'package.json': manifest({ 'color-kit': '^2.1.0' }) }, {}, [
      'package.json',
    ])
    expect(text).toContain('No lockfile next to these package.json files')
  })
})

describe('Go', () => {
  test('a require with go.sum entries is consistent; a missing one is flagged', async () => {
    const sum = [
      'example.com/colors v1.2.0 h1:aaa=',
      'example.com/colors v1.2.0/go.mod h1:bbb=',
      'example.com/hue v0.3.0/go.mod h1:ccc=',
    ].join('\n')
    const ok = await section(
      {
        'go.mod': goMod(['example.com/colors v1.2.0', 'example.com/hue v0.3.0 // indirect']),
        'go.sum': sum,
      },
      { 'go.mod': goMod(['example.com/colors v1.1.0']), 'go.sum': '' },
      ['go.mod', 'go.sum'],
    )
    expect(ok).toContain('### go.mod (Go)')
    expect(ok).toContain('- `example.com/colors` v1.1.0 → v1.2.0')
    expect(ok).toContain('- added `example.com/hue` v0.3.0 (indirect)')
    expect(ok).toContain('Consistency: OK. go.sum has entries for all 2 modules')
    const missing = await section(
      { 'services/api/go.mod': goMod(['example.com/colors v1.3.0']), 'services/api/go.sum': sum },
      {},
      ['services/api/go.mod'],
    )
    expect(missing).toContain('### services/api/go.mod (Go)')
    expect(missing).toContain(
      'go.mod requires `example.com/colors` v1.3.0, but go.sum has no entry',
    )
  })
})

test('a merge request without dependency files gets no section', async () => {
  expect(await section({ 'src/a.ts': '' }, {}, ['src/a.ts'])).toBe('')
})

test('the section stays within its size limit', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [`widget-part-${i}`, `^1.${i}.0`]),
  )
  const text = await section(
    { 'package.json': manifest(many), 'package-lock.json': npmLock({}, {}) },
    { 'package.json': manifest({}) },
    ['package.json'],
  )
  expect(text.length).toBeLessThanOrEqual(DEPENDENCY_SECTION_MAX_CHARS + 80)
  expect(text).toContain('more changes')
  expect(text).toContain('more problems')
})
