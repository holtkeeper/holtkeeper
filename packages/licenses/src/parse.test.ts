import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { npmTarball, parseOsvLicenses } from './parse.ts'

const captured = () => Bun.file(join(import.meta.dir, '../test/osv-npm.json')).json()
const capturedDir = '/private/tmp/claude-501/osv-XdkO'

test('reads packages, licenses and dependency groups from captured osv-scanner 2.7 output', async () => {
  const packages = parseOsvLicenses(await captured(), capturedDir)
  expect(packages).toHaveLength(51)
  expect(packages.find((pkg) => pkg.name === 'qs')).toEqual({
    name: 'qs',
    version: '6.7.0',
    ecosystem: 'npm',
    sources: ['package-lock.json'],
    licenses: ['BSD-3-Clause'],
  })
  expect(packages.find((pkg) => pkg.name === 'vary')?.groups).toEqual(['dev'])
  expect(packages.filter((pkg) => pkg.name === 'ms').map((pkg) => pkg.version)).toEqual([
    '2.0.0',
    '2.1.1',
  ])
  expect(new Set(packages.flatMap((pkg) => pkg.licenses))).toEqual(
    new Set(['MIT', 'ISC', 'BSD-3-Clause']),
  )
})

const pkg = (licenses?: string[]) => ({
  package: { name: 'a', version: '1.0.0', ecosystem: 'npm' },
  ...(licenses ? { licenses } : {}),
})

test('merges a package found in several sources and drops UNKNOWN next to real licenses', () => {
  const packages = parseOsvLicenses(
    {
      results: [
        {
          source: { path: '/r/package-lock.json', type: 'lockfile' },
          packages: [pkg(['UNKNOWN'])],
        },
        {
          source: { path: '/r/web/package-lock.json', type: 'lockfile' },
          packages: [pkg(['MIT'])],
        },
        {
          source: { path: '/r/go.mod', type: 'lockfile' },
          packages: [{ package: { name: 'b', ecosystem: 'Go' } }],
        },
      ],
    },
    '/r',
  )
  expect(packages).toEqual([
    { name: 'b', version: '', ecosystem: 'Go', sources: ['go.mod'], licenses: [] },
    {
      name: 'a',
      version: '1.0.0',
      ecosystem: 'npm',
      sources: ['package-lock.json', 'web/package-lock.json'],
      licenses: ['MIT'],
    },
  ])
  expect(parseOsvLicenses({}, '/r')).toEqual([])
})

test('reads the npm package and version from registry tarball URLs', () => {
  expect(
    npmTarball(
      'https://gitlab.example.com/api/v4/projects/123/packages/npm/@acme/some-lib/-/@acme/some-lib-1.2.3.tgz',
    ),
  ).toEqual({ name: '@acme/some-lib', version: '1.2.3' })
  expect(npmTarball('https://registry.example.com/@acme/ui/-/ui-2.0.0-beta.1.tgz#abc')).toEqual({
    name: '@acme/ui',
    version: '2.0.0-beta.1',
  })
  expect(npmTarball('https://registry.example.com/widget/-/widget-0.4.1.tgz')).toEqual({
    name: 'widget',
    version: '0.4.1',
  })
  expect(npmTarball('https://registry.example.com/@acme%2fui/-/ui-1.0.0.tgz')?.name).toBe(
    '@acme/ui',
  )
  expect(npmTarball('https://example.com/acme/widget.git')).toBeUndefined()
  expect(npmTarball('https://registry.example.com/widget/-/other-1.0.0.tgz')).toBeUndefined()
  expect(npmTarball('widget')).toBeUndefined()
})

test('turns GIT tarball entries into npm packages and merges them with registry entries', () => {
  const url =
    'https://gitlab.example.com/api/v4/projects/7/packages/npm/@acme/widget/-/@acme/widget-1.0.0.tgz'
  const packages = parseOsvLicenses(
    {
      results: [
        {
          source: { path: '/r/yarn.lock', type: 'lockfile' },
          packages: [{ package: { name: url, version: '', ecosystem: 'GIT' } }],
        },
        {
          source: { path: '/r/web/package-lock.json', type: 'lockfile' },
          packages: [
            {
              package: { name: '@acme/widget', version: '1.0.0', ecosystem: 'npm' },
              licenses: ['MIT'],
            },
          ],
        },
      ],
    },
    '/r',
  )
  expect(packages).toEqual([
    {
      name: '@acme/widget',
      version: '1.0.0',
      ecosystem: 'npm',
      sources: ['yarn.lock', 'web/package-lock.json'],
      licenses: ['MIT'],
    },
  ])
})
