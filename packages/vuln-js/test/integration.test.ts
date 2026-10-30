import { afterEach, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'
import type { Finding } from '@holtkeeper/vuln'

import { jsFixer } from '../src/index.ts'

const fixture = join(import.meta.dir, '../../../fixtures/npm')

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function copyFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hk-vuln-js-'))
  dirs.push(dir)
  await cp(fixture, dir, { recursive: true })
  return dir
}

// qs@6.7.0 comes in through express@4.17.1 and body-parser; GHSA-hrpp-h998-j3pp is fixed in 6.7.3.
const qs = (source: string): Finding => ({
  id: 'GHSA-hrpp-h998-j3pp',
  aliases: ['CVE-2022-24999'],
  summary: 'qs vulnerable to Prototype Pollution',
  severity: 'high',
  url: 'https://osv.dev/vulnerability/GHSA-hrpp-h998-j3pp',
  package: { name: 'qs', version: '6.7.0', ecosystem: 'npm' },
  source,
  fixedVersions: ['6.7.3'],
})

const lodash = (source: string): Finding => ({
  id: 'GHSA-35jh-r3h4-6jhm',
  aliases: ['CVE-2021-23337'],
  summary: 'Command Injection in lodash',
  severity: 'high',
  url: 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm',
  package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
  source,
  fixedVersions: ['4.17.21'],
})

describe('jsFixer with real package managers', () => {
  test.skipIf(!Bun.which('npm'))(
    'npm: overrides a transitive package and raises a direct one',
    async () => {
      const dir = await copyFixture()
      const before = await Bun.file(join(dir, 'package-lock.json')).text()
      const source = 'package-lock.json'
      const result = await jsFixer().fix({ dir, source, findings: [qs(source), lodash(source)] })

      expect(result.changedFiles.toSorted()).toEqual(['package-lock.json', 'package.json'])
      expect(result.fixed.toSorted()).toEqual(['GHSA-35jh-r3h4-6jhm', 'GHSA-hrpp-h998-j3pp'])
      const manifest = await Bun.file(join(dir, 'package.json')).json()
      expect(manifest.dependencies.lodash).toBe('^4.17.21')
      expect(manifest.overrides).toEqual({ 'qs@>=6.7.0 <6.7.3': '^6.7.3' })

      const lock = await Bun.file(join(dir, 'package-lock.json')).json()
      expect(lock).not.toEqual(JSON.parse(before))
      expect(Bun.semver.order(lock.packages['node_modules/qs'].version, '6.7.3')).toBeGreaterThan(
        -1,
      )
      expect(lock.packages['node_modules/lodash'].version).not.toBe('4.17.15')
      expect(await Bun.file(join(dir, 'node_modules')).exists()).toBe(false)
    },
    120_000,
  )

  test.skipIf(!Bun.which('bun'))(
    'bun: overrides a transitive package in bun.lock',
    async () => {
      const dir = await copyFixture()
      await localRunner.run(['bun', 'install', '--lockfile-only', '--ignore-scripts'], { cwd: dir })
      await rm(join(dir, 'package-lock.json'))
      const before = await Bun.file(join(dir, 'bun.lock')).text()
      expect(before).toContain('"qs@6.7.0"')

      const result = await jsFixer().fix({ dir, source: 'bun.lock', findings: [qs('bun.lock')] })

      expect(result.changedFiles.toSorted()).toEqual(['bun.lock', 'package.json'])
      expect(result.fixed).toEqual(['GHSA-hrpp-h998-j3pp'])
      expect((await Bun.file(join(dir, 'package.json')).json()).overrides).toEqual({
        'qs@>=6.7.0 <6.7.3': '^6.7.3',
      })
      expect(await Bun.file(join(dir, 'bun.lock')).text()).not.toContain('"qs@6.7.0"')
    },
    120_000,
  )
})
