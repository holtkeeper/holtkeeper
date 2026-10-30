import { expect, test } from 'bun:test'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { analyzeLicenses } from '../src/index.ts'

const fixture = join(import.meta.dir, '../../../fixtures/npm')

// osv-scanner fetches licenses from deps.dev, so the scan itself is replayed from a capture of
// `osv-scanner scan source --all-packages --licenses` over fixtures/npm (with one package marked dev).
test('judges the npm fixture from captured osv-scanner output', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'licenses-')))
  try {
    await cp(fixture, dir, { recursive: true })
    const captured = (await Bun.file(join(import.meta.dir, 'osv-npm.json')).text()).replaceAll(
      '/private/tmp/claude-501/osv-XdkO',
      dir,
    )
    const { runner } = createFakeRunner((command) =>
      command[1] === 'scan'
        ? { exitCode: 1, stdout: captured }
        : { stdout: 'osv-scanner version: 2.7.0' },
    )
    const data = await analyzeLicenses({ dir, runner, policy: { allow: ['MIT', 'ISC'] } })
    expect(data.packages).toHaveLength(51)
    expect(
      data.packages
        .filter((pkg) => pkg.verdict !== 'allowed')
        .map((pkg) => `${pkg.name} ${pkg.verdict} ${pkg.sources.join()}`),
    ).toEqual(['qs unlisted package-lock.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
