import { expect, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeLicenses, evaluatePackages, resolvePolicy } from './analyze.ts'
import { licensesOptionsSchema } from './analyzer.ts'

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
  expect(licensesOptionsSchema.parse({})).toEqual(resolvePolicy())
  expect(licensesOptionsSchema.parse({ allow: 'MIT, ISC', ignore: ['x'] })).toMatchObject({
    allow: ['MIT', 'ISC'],
    ignore: ['x'],
  })
  expect(evaluatePackages([], resolvePolicy())).toEqual([])
})
