import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { parseOsvLicenses } from './parse.ts'

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
