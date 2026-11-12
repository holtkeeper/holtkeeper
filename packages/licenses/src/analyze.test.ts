import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeLicenses, evaluatePackages, projectLicenseFiles, resolvePolicy } from './analyze.ts'
import { licensePresets, licensesOptionsSchema } from './analyzer.ts'

test('runs osv-scanner with licenses for all packages and judges them', async () => {
  const dir = await realpath(tmpdir())
  const { runner, calls } = createFakeRunner((command) => {
    if (command[1] === '--version') return { stdout: 'osv-scanner version: 2.7.0\ncommit: x\n' }
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        results: [
          {
            source: { path: join(dir, 'package-lock.json'), type: 'lockfile' },
            packages: [
              {
                package: { name: 'left-pad', version: '1.3.0', ecosystem: 'npm' },
                licenses: ['WTFPL'],
              },
              {
                package: { name: 'readline', version: '8.0.0', ecosystem: 'npm' },
                licenses: ['GPL-3.0-or-later'],
              },
              {
                package: { name: 'react', version: '19.0.0', ecosystem: 'npm' },
                licenses: ['MIT'],
              },
              {
                package: { name: '@internal/tool', version: '1.0.0', ecosystem: 'npm' },
                licenses: ['UNKNOWN'],
              },
            ],
          },
        ],
      }),
    }
  })
  const data = await analyzeLicenses({ dir, runner, policy: { ignore: ['@internal/*'] } })
  expect(calls[1]?.command).toEqual([
    'osv-scanner',
    'scan',
    'source',
    '--recursive',
    '--allow-no-lockfiles',
    '--all-packages',
    '--licenses',
    '--format',
    'json',
    dir,
  ])
  expect(data.tool).toEqual({ name: 'osv-scanner', version: '2.7.0' })
  expect(data.policy.deny).toEqual(['GPL-*', 'AGPL-*', 'SSPL-*'])
  expect(Object.fromEntries(data.packages.map((pkg) => [pkg.name, pkg.verdict]))).toEqual({
    '@internal/tool': 'ignored',
    'left-pad': 'unlisted',
    react: 'allowed',
    readline: 'denied',
  })
})

test('fails when osv-scanner fails', async () => {
  const { runner } = createFakeRunner((command) =>
    command[1] === 'scan' ? { exitCode: 127, stderr: 'boom' } : {},
  )
  const error: unknown = await analyzeLicenses({ dir: tmpdir(), runner }).catch(
    (caught: unknown) => caught,
  )
  expect(String(error)).toContain('boom')
})

test('options take lists or comma-separated flags and default to the permissive policy', () => {
  expect(licensesOptionsSchema.parse({})).toEqual({
    ...resolvePolicy(),
    review: [],
    unknown: 'warn',
    devDependencies: 'check',
    exceptions: [],
    requireProjectLicense: false,
  })
  expect(licensesOptionsSchema.parse({ allow: 'MIT, ISC', ignore: ['x'] })).toMatchObject({
    allow: ['MIT', 'ISC'],
    ignore: ['x'],
  })
  expect(evaluatePackages([], resolvePolicy())).toEqual([])
})

const scanned = (name: string, licenses: string[]) => ({
  name,
  version: '1.0.0',
  ecosystem: 'npm',
  sources: ['package-lock.json'],
  licenses,
})

test('unknown: violation judges packages without a usable license not allowed', () => {
  const packages = [scanned('a', []), scanned('b', ['UNKNOWN']), scanned('c', ['MIT'])]
  expect(evaluatePackages(packages, resolvePolicy()).map((pkg) => pkg.verdict)).toEqual([
    'unknown',
    'unknown',
    'allowed',
  ])
  const strict = evaluatePackages(packages, resolvePolicy({ unknown: 'violation' }))
  expect(strict.map((pkg) => [pkg.verdict, pkg.culprits])).toEqual([
    ['unlisted', ['UNKNOWN']],
    ['unlisted', ['UNKNOWN']],
    ['allowed', undefined],
  ])
  expect(resolvePolicy({ unknown: 'violation' }).unknown).toBe('violation')
  expect(resolvePolicy({ unknown: 'warn' })).toEqual(resolvePolicy())
})

const internal = (ecosystem: string, name: string) =>
  ecosystem === 'npm' && name.startsWith('@co/') ? 'work:libs/ui' : undefined

test('packages analyzed repositories define are internal; ignore still wins', () => {
  const result = evaluatePackages(
    [scanned('@co/ui', []), scanned('@co/skip', []), scanned('left-pad', [])],
    resolvePolicy({ ignore: ['@co/skip'], unknown: 'violation' }),
    internal,
  )
  expect(result.map(({ name, verdict, definedIn }) => [name, verdict, definedIn])).toEqual([
    ['@co/ui', 'internal', 'work:libs/ui'],
    ['@co/skip', 'ignored', undefined],
    ['left-pad', 'unlisted', undefined],
  ])
})

test('finds license files at the repository root only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-licenses-'))
  await writeFile(join(dir, 'LICENSE-MIT'), 'MIT')
  await writeFile(join(dir, 'COPYING.md'), 'GPL')
  await writeFile(join(dir, 'licenses.json'), '{}')
  await writeFile(join(dir, 'README.md'), '')
  await mkdir(join(dir, 'LICENSE'))
  expect(await projectLicenseFiles(dir)).toEqual(['COPYING.md', 'LICENSE-MIT'])
})

test('presets are valid options with unique ids', () => {
  expect(new Set(licensePresets.map((preset) => preset.id)).size).toBe(licensePresets.length)
  for (const preset of licensePresets)
    expect(licensesOptionsSchema.safeParse(preset.options).success, preset.id).toBe(true)
  const commercial = licensePresets.find((preset) => preset.id === 'commercial')?.options
  const policy = resolvePolicy(commercial)
  const verdicts = evaluatePackages(
    [scanned('gpl', ['GPL-3.0-only']), scanned('mpl', ['MPL-2.0']), scanned('zlib', ['Zlib'])],
    policy,
  ).map((pkg) => pkg.verdict)
  expect(verdicts).toEqual(['denied', 'unlisted', 'allowed'])
})

test('review licenses need a sign-off even when allowed; deny still wins', () => {
  const policy = resolvePolicy({ allow: ['MIT', 'MPL-*'], review: ['MPL-2.0'], deny: ['MPL-1.1'] })
  expect(policy.review).toEqual(['MPL-2.0'])
  const packages = [
    scanned('a', ['MIT']),
    scanned('b', ['MPL-2.0']),
    scanned('c', ['MPL-1.1']),
    scanned('d', ['MIT OR MPL-2.0']),
  ]
  expect(evaluatePackages(packages, policy).map((pkg) => [pkg.verdict, pkg.culprits])).toEqual([
    ['allowed', undefined],
    ['unlisted', ['MPL-2.0']],
    ['denied', ['MPL-1.1']],
    ['allowed', undefined],
  ])
})

test('devDependencies: ignore leaves out packages only dev groups use', () => {
  const dev = { ...scanned('dev-tool', ['GPL-3.0-only']), groups: ['dev'] }
  const both = { ...scanned('shared', ['GPL-3.0-only']), groups: ['dev', 'optional'] }
  expect(evaluatePackages([dev, both], resolvePolicy()).map((pkg) => pkg.verdict)).toEqual([
    'denied',
    'denied',
  ])
  const policy = resolvePolicy({ devDependencies: 'ignore' })
  expect(policy.devDependencies).toBe('ignore')
  expect(evaluatePackages([dev, both], policy).map((pkg) => pkg.verdict)).toEqual([
    'ignored',
    'denied',
  ])
})

test('exceptions accept matching packages that would not pass until they expire', () => {
  const options = {
    exceptions: [
      {
        package: 'widget-*',
        license: 'GPL-3.0-only',
        reason: 'Build tool only.',
        expires: '2026-12-31',
      },
      { package: 'some-lib', version: '2.0.0', reason: 'Vendor agreement ABC-123.' },
      { package: 'old-lib', reason: 'Expired.', expires: '2026-01-01' },
    ],
  }
  const policy = resolvePolicy(options, '2026-11-12')
  expect(policy.exceptions?.map((exception) => exception.package)).toEqual(['widget-*', 'some-lib'])
  expect(resolvePolicy(options).exceptions).toHaveLength(3)
  const packages = [
    scanned('widget-cli', ['GPL-3.0-only']),
    scanned('widget-core', ['AGPL-3.0-only']),
    { ...scanned('some-lib', ['SSPL-1.0']), version: '2.0.0' },
    scanned('some-lib', ['SSPL-1.0']),
    scanned('old-lib', ['GPL-3.0-only']),
    scanned('widget-ok', ['MIT']),
  ]
  expect(
    evaluatePackages(packages, policy).map((pkg) => [pkg.name, pkg.verdict, pkg.exception]),
  ).toEqual([
    ['widget-cli', 'excepted', 'Build tool only.'],
    ['widget-core', 'denied', undefined],
    ['some-lib', 'excepted', 'Vendor agreement ABC-123.'],
    ['some-lib', 'denied', undefined],
    ['old-lib', 'denied', undefined],
    ['widget-ok', 'allowed', undefined],
  ])
})

test('analyze applies review, dev and exception options from the analyzer settings', async () => {
  const dir = await realpath(tmpdir())
  const { runner } = createFakeRunner((command) => {
    if (command[1] === '--version') return { stdout: '' }
    return {
      stdout: JSON.stringify({
        results: [
          {
            source: { path: join(dir, 'package-lock.json'), type: 'lockfile' },
            packages: [
              {
                package: { name: 'mpl', version: '1.0.0', ecosystem: 'npm' },
                licenses: ['MPL-2.0'],
              },
              {
                package: { name: 'lint-kit', version: '1.0.0', ecosystem: 'npm' },
                licenses: ['GPL-3.0-only'],
                dependency_groups: ['dev'],
              },
              {
                package: { name: 'fooUtil', version: '3.1.0', ecosystem: 'npm' },
                licenses: ['BUSL-1.1'],
              },
            ],
          },
        ],
      }),
    }
  })
  const policy = licensesOptionsSchema.parse({
    allow: 'MIT, MPL-2.0',
    review: 'MPL-*',
    devDependencies: 'ignore',
    exceptions: [{ package: 'fooUtil', reason: 'Licensed by contract.', expires: '2027-01-01' }],
  })
  const data = await analyzeLicenses({ dir, runner, policy, today: '2026-11-12' })
  expect(Object.fromEntries(data.packages.map((pkg) => [pkg.name, pkg.verdict]))).toEqual({
    mpl: 'unlisted',
    'lint-kit': 'ignored',
    fooUtil: 'excepted',
  })
  expect(data.policy).toMatchObject({
    review: ['MPL-*'],
    devDependencies: 'ignore',
    exceptions: [{ package: 'fooUtil', reason: 'Licensed by contract.', expires: '2027-01-01' }],
  })
})
