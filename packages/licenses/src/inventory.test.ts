import { expect, test } from 'bun:test'

import { INDEX_TOOL, inventoryLicenses, sameLicensesState } from './inventory.ts'

const packages = [
  { ecosystem: 'npm', name: 'widget', version: '1.0.0', source: 'package-lock.json' },
  { ecosystem: 'npm', name: 'widget', version: '1.0.0', source: 'web/package-lock.json' },
  { ecosystem: 'npm', name: 'copyleft-kit', version: '2.0.0', source: 'package-lock.json' },
  { ecosystem: 'npm', name: 'lint-kit', version: '3.0.0', source: 'package-lock.json' },
  { ecosystem: 'npm', name: '@acme/shapes', version: '4.0.0', source: 'package-lock.json' },
  { ecosystem: 'Go', name: 'example.com/mystery', version: '0.1.0', source: 'go.mod' },
]

const licenses = new Map([
  ['npm:widget@1.0.0', ['MIT']],
  ['npm:copyleft-kit@2.0.0', ['GPL-3.0-only']],
  ['npm:lint-kit@3.0.0', ['GPL-3.0-only']],
  ['Go:example.com/mystery@0.1.0', ['UNKNOWN']],
])

const build = (licenseFiles?: string[]) =>
  inventoryLicenses({
    packages,
    licenses,
    policy: { devDependencies: 'ignore' },
    internal: (_ecosystem, name) => (name.startsWith('@acme/') ? 'gitlab:acme/shapes' : undefined),
    devOnly: (_ecosystem, name) => name === 'lint-kit',
    today: '2026-11-18',
    ...(licenseFiles && { licenseFiles }),
  })

test('judges resolved packages with their looked-up licenses, one entry per version', () => {
  const data = build(['LICENSE'])
  expect(data.tool).toEqual({ name: INDEX_TOOL })
  expect(data.project).toEqual({ licenseFiles: ['LICENSE'] })
  expect(data.packages.map((pkg) => [pkg.name, pkg.verdict])).toEqual([
    ['example.com/mystery', 'unknown'],
    ['@acme/shapes', 'internal'],
    ['copyleft-kit', 'denied'],
    ['lint-kit', 'ignored'],
    ['widget', 'allowed'],
  ])
  expect(data.packages.find((pkg) => pkg.name === 'widget')?.sources).toEqual([
    'package-lock.json',
    'web/package-lock.json',
  ])
  expect(data.packages.find((pkg) => pkg.name === 'lint-kit')?.groups).toEqual(['dev'])
  expect(data.packages[0]?.licenses).toEqual([])
  expect(build().project).toBeUndefined()
})

test('the same judgement compares equal whatever the tool and key order', () => {
  const data = build(['LICENSE'])
  const shuffled = JSON.parse(
    JSON.stringify({
      ...data,
      tool: { name: 'osv-scanner' },
      packages: data.packages.toReversed(),
    }),
  )
  expect(sameLicensesState(data, shuffled)).toBe(true)
  expect(sameLicensesState(data, build())).toBe(false)
  expect(
    sameLicensesState(data, {
      ...data,
      packages: data.packages.map((pkg) =>
        pkg.name === 'widget' ? { ...pkg, verdict: 'unknown' as const } : pkg,
      ),
    }),
  ).toBe(false)
})
