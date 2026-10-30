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
    unknown: 'warn',
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
