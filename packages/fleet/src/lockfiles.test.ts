import { describe, expect, test } from 'bun:test'

import { parseBunLock, parsePackageLock, parsePnpmLock } from './lockfiles.ts'

describe('lockfiles', () => {
  test('bun.lock prefers workspace-specific entries', () => {
    const lock = parseBunLock(`{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "root", "dependencies": { "react": "^18.0.0" } },
        "packages/legacy": { "name": "legacy", "dependencies": { "react": "^17.0.0" } },
      },
      "packages": {
        "react": ["react@18.3.1", "", {}, "sha512-x"],
        "legacy/react": ["react@17.0.2", "", {}, "sha512-y"],
        "legacy": ["legacy@workspace:packages/legacy"],
      },
    }`)
    expect(lock.importers).toEqual(['.', 'packages/legacy'])
    expect(lock.resolve('.', 'react')).toBe('18.3.1')
    expect(lock.resolve('packages/legacy', 'react')).toBe('17.0.2')
    expect(lock.resolve('.', 'legacy')).toBeUndefined()
  })

  test('package-lock.json resolves nested installs first', () => {
    const lock = parsePackageLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root' },
          'packages/a': { name: 'a' },
          'node_modules/a': { resolved: 'packages/a', link: true },
          'node_modules/lodash': { version: '4.17.21' },
          'packages/a/node_modules/lodash': { version: '3.10.1' },
        },
      }),
    )
    expect(lock.importers).toEqual(['.', 'packages/a'])
    expect(lock.resolve('.', 'lodash')).toBe('4.17.21')
    expect(lock.resolve('packages/a', 'lodash')).toBe('3.10.1')
    expect(lock.resolve('.', 'a')).toBeUndefined()
  })

  test('pnpm-lock.yaml strips peer suffixes', () => {
    const lock = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      react-dom:',
        '        specifier: ^18.2.0',
        '        version: 18.3.1(react@18.3.1)',
        '  packages/ui:',
        '    devDependencies:',
        '      react:',
        '        specifier: ^18.0.0',
        '        version: 18.2.0',
        '      shared:',
        '        specifier: workspace:*',
        '        version: link:../shared',
      ].join('\n'),
    )
    expect(lock.importers).toEqual(['.', 'packages/ui'])
    expect(lock.resolve('.', 'react-dom')).toBe('18.3.1')
    expect(lock.resolve('packages/ui', 'react')).toBe('18.2.0')
    expect(lock.resolve('packages/ui', 'shared')).toBeUndefined()
  })
})
