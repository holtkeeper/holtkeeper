import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localRunner } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import { type Finding, runAudit } from '@holtkeeper/vuln'

import { osvFixer } from './fixer.ts'
import { osvScanner } from './scanner.ts'

const npmFixture = join(import.meta.dir, '../../../fixtures/npm')
const hasOsv = Bun.which('osv-scanner') !== null

let dir: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'holtkeeper-osv-')))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const finding = (id: string, source = 'package-lock.json'): Finding => ({
  id,
  aliases: [],
  summary: '',
  severity: 'high',
  url: '',
  package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
  source,
  fixedVersions: ['4.17.21'],
})

describe('osvScanner', () => {
  test('runs a recursive JSON scan and accepts exit code 1', async () => {
    const output = {
      results: [
        { source: { path: join(dir, 'web/package-lock.json'), type: 'lockfile' }, packages: [] },
      ],
    }
    const { runner, calls } = createFakeRunner(() => ({
      exitCode: 1,
      stdout: JSON.stringify(output),
    }))
    expect(await osvScanner({ runner, args: ['--offline'] }).scan(dir)).toEqual([])
    expect(calls[0]?.command).toEqual([
      'osv-scanner',
      'scan',
      'source',
      '--recursive',
      '--allow-no-lockfiles',
      '--format',
      'json',
      '--offline',
      dir,
    ])
  })

  test('fails on other exit codes', async () => {
    const { runner } = createFakeRunner(() => ({ exitCode: 127, stderr: 'broken' }))
    expect(osvScanner({ runner }).scan(dir)).rejects.toThrow('exited with 127')
  })
})

describe('osvFixer', () => {
  test('supports npm lockfiles and pom.xml only', () => {
    const fixer = osvFixer()
    expect(
      ['package-lock.json', 'a/pom.xml', 'bun.lock', 'go.mod'].map((s) => fixer.supports(s)),
    ).toEqual([true, true, false, false])
  })

  test('relaxes npm projects that have a manifest and reports patched findings', async () => {
    await writeFile(join(dir, 'package.json'), '{}')
    await writeFile(join(dir, 'package-lock.json'), '{}')
    const { runner, calls } = createFakeRunner(async () => {
      await writeFile(join(dir, 'package-lock.json'), '{"changed":true}')
      return {
        stdout: JSON.stringify({
          vulnerabilities: [{ id: 'GHSA-b', unactionable: true }],
          patches: [{ fixed: [{ id: 'GHSA-a' }] }],
        }),
      }
    })

    const result = await osvFixer({ runner }).fix({
      dir,
      source: 'package-lock.json',
      findings: [finding('GHSA-a'), finding('GHSA-b')],
    })

    expect(calls[0]?.command).toEqual([
      'osv-scanner',
      'fix',
      '--strategy',
      'relax',
      '-M',
      'package.json',
      '-L',
      'package-lock.json',
      '--format',
      'json',
      '--no-introduce',
      '--vulns',
      'GHSA-a',
      '--vulns',
      'GHSA-b',
    ])
    expect(result).toEqual({
      changedFiles: ['package-lock.json'],
      fixed: ['GHSA-a'],
      notes: ['GHSA-b (lodash): no allowed upgrade fixes it'],
    })
  })

  test('fixes lockfiles in place without a manifest and claims nothing when files did not change', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{}')
    const { runner, calls } = createFakeRunner(() => ({
      stdout: JSON.stringify({ patches: [{ fixed: [{ id: 'GHSA-a' }] }] }),
    }))
    const result = await osvFixer({ runner, upgrade: 'patch' }).fix({
      dir,
      source: 'package-lock.json',
      findings: [finding('GHSA-a')],
    })
    expect(calls[0]?.command.slice(2, 6)).toEqual([
      '--strategy',
      'in-place',
      '-L',
      'package-lock.json',
    ])
    expect(calls[0]?.command).toContain('patch')
    expect(result.fixed).toEqual([])
  })

  test('uses overrides for Maven', async () => {
    const { runner, calls } = createFakeRunner()
    await osvFixer({ runner }).fix({
      dir,
      source: 'svc/pom.xml',
      findings: [finding('GHSA-a', 'svc/pom.xml')],
    })
    expect(calls[0]?.command.slice(2, 6)).toEqual(['--strategy', 'override', '-M', 'svc/pom.xml'])
  })
})

describe.skipIf(!hasOsv)('osv-scanner integration', () => {
  test('finds and fixes vulnerabilities in the npm fixture', async () => {
    await cp(npmFixture, dir, { recursive: true })
    const scanner = osvScanner({ runner: localRunner })

    const report = await runAudit({ dir, scanner, fixers: [osvFixer()] })

    expect(report.resolved.some((f) => f.package.name === 'lodash')).toBe(true)
    expect(report.changedFiles.toSorted()).toEqual(['package-lock.json', 'package.json'])
    expect(report.findings.length).toBeLessThan(report.resolved.length)
  }, 120_000)
})
