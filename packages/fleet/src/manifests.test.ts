import { describe, expect, test } from 'bun:test'

import {
  globToRegExp,
  parseGoMod,
  parseGoWork,
  parsePackageJson,
  parsePnpmWorkspace,
  workspaceDirs,
} from './manifests.ts'

describe('manifests', () => {
  test('reads dependencies and workspaces of package.json', () => {
    const manifest = parsePackageJson(
      JSON.stringify({
        name: 'app',
        workspaces: { packages: ['packages/*', '!packages/legacy'] },
        dependencies: { react: '^18.2.0' },
        devDependencies: { react: '^18.0.0', typescript: '~5.4.0' },
        peerDependencies: { 'react-dom': '>=18' },
      }),
    )
    expect(manifest.name).toBe('app')
    expect(manifest.workspaces).toEqual(['packages/*'])
    expect(manifest.dependencies).toEqual([
      { name: 'react', declared: '^18.2.0', kind: 'prod' },
      { name: 'typescript', declared: '~5.4.0', kind: 'dev' },
      { name: 'react-dom', declared: '>=18', kind: 'peer' },
    ])
  })

  test('reads pnpm-workspace.yaml', () => {
    expect(parsePnpmWorkspace("packages:\n  - 'apps/*'\n  - '!apps/old'\n")).toEqual(['apps/*'])
  })

  test('reads go.mod requirements', () => {
    const mod = parseGoMod(
      [
        'module github.com/acme/api',
        '',
        'go 1.22',
        '',
        'require github.com/google/uuid v1.6.0',
        'require (',
        '\tgithub.com/spf13/cobra v1.8.0',
        '\tgolang.org/x/sys v0.20.0 // indirect',
        ')',
        'replace example.com/a => ../a',
      ].join('\n'),
    )
    expect(mod.module).toBe('github.com/acme/api')
    expect(mod.requires).toEqual([
      { name: 'github.com/google/uuid', declared: 'v1.6.0', kind: 'prod' },
      { name: 'github.com/spf13/cobra', declared: 'v1.8.0', kind: 'prod' },
      { name: 'golang.org/x/sys', declared: 'v0.20.0', kind: 'indirect' },
    ])
  })

  test('reads go.work modules', () => {
    expect(parseGoWork('go 1.22\n\nuse (\n\t.\n\t./tools/\n)\nuse ./cmd')).toEqual([
      '.',
      'tools',
      'cmd',
    ])
  })

  test('expands workspace globs against known directories only', () => {
    expect(globToRegExp('packages/*').test('packages/a')).toBe(true)
    expect(globToRegExp('packages/*').test('packages/a/b')).toBe(false)
    expect(globToRegExp('packages/**').test('packages/a/b')).toBe(true)
    expect(
      workspaceDirs(['packages/*', './tools'], ['.', 'packages/b', 'packages/a', 'apps/x'], 10),
    ).toEqual(['packages/a', 'packages/b', 'tools'])
    expect(workspaceDirs(['packages/*'], ['packages/a', 'packages/b'], 1)).toEqual(['packages/a'])
  })
})
