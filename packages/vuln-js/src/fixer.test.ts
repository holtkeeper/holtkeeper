import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandError } from '@holtkeeper/exec'
import { createFakeRunner } from '@holtkeeper/exec/testing'
import type { Finding } from '@holtkeeper/vuln'

import { jsFixer } from './fixer.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'hk-vuln-js-'))
  dirs.push(dir)
  await Promise.all(Object.entries(files).map(([path, text]) => Bun.write(join(dir, path), text)))
  return dir
}

const qs = (source: string): Finding => ({
  id: 'GHSA-hrpp-h998-j3pp',
  aliases: ['CVE-2022-24999'],
  summary: 'qs prototype pollution',
  severity: 'high',
  url: 'https://osv.dev/vulnerability/GHSA-hrpp-h998-j3pp',
  package: { name: 'qs', version: '6.7.0', ecosystem: 'npm' },
  source,
  fixedVersions: ['6.7.3'],
})

describe('jsFixer', () => {
  test('supports JavaScript lockfiles only', () => {
    const fixer = jsFixer()
    expect(fixer.name).toBe('js')
    expect(fixer.supports('web/bun.lock')).toBe(true)
    expect(fixer.supports('yarn.lock')).toBe(true)
    expect(fixer.supports('go.mod')).toBe(false)
  })

  test('edits the manifest and updates the lockfile in the project directory', async () => {
    const dir = await project({
      'web/package.json': '{\n    "name": "web"\n}\n',
      'web/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    })
    const { runner, calls } = createFakeRunner(async (_, { cwd }) => {
      await Bun.write(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# updated\n')
      return undefined
    })
    const result = await jsFixer({ runner }).fix({
      dir,
      source: 'web/pnpm-lock.yaml',
      findings: [qs('web/pnpm-lock.yaml')],
    })

    expect(calls.map((call) => [call.command, call.options.cwd])).toEqual([
      [['pnpm', 'install', '--lockfile-only', '--ignore-scripts'], join(dir, 'web')],
    ])
    expect(result).toEqual({
      changedFiles: ['web/package.json', 'web/pnpm-lock.yaml'],
      fixed: ['GHSA-hrpp-h998-j3pp'],
      notes: [],
    })
    expect(await Bun.file(join(dir, 'web/package.json')).text()).toBe(
      '{\n    "name": "web",\n    "pnpm": {\n        "overrides": {\n' +
        '            "qs@>=6.7.0 <6.7.3": "^6.7.3"\n        }\n    }\n}\n',
    )
  })

  test('detects yarn berry from packageManager', async () => {
    const dir = await project({
      'package.json': '{ "packageManager": "yarn@4.5.0" }',
      'yarn.lock': '',
    })
    const { runner, calls } = createFakeRunner()
    await jsFixer({ runner }).fix({ dir, source: 'yarn.lock', findings: [qs('yarn.lock')] })
    expect(calls[0]?.command).toEqual(['yarn', 'install', '--mode=update-lockfile'])
    expect(await Bun.file(join(dir, 'package.json')).json()).toEqual({
      packageManager: 'yarn@4.5.0',
      resolutions: { qs: '^6.7.3' },
    })
  })

  test('does not run the package manager when nothing changes', async () => {
    const dir = await project({ 'package.json': '{}', 'bun.lock': '{}' })
    const { runner, calls } = createFakeRunner()
    const finding = { ...qs('bun.lock'), fixedVersions: [] }
    const result = await jsFixer({ runner }).fix({ dir, source: 'bun.lock', findings: [finding] })
    expect(calls).toHaveLength(0)
    expect(result.changedFiles).toEqual([])
    expect(result.notes).toHaveLength(1)
  })

  test('reports a missing package.json', async () => {
    const dir = await project({ 'bun.lock': '{}' })
    const { runner } = createFakeRunner()
    const result = await jsFixer({ runner }).fix({
      dir,
      source: 'bun.lock',
      findings: [qs('bun.lock')],
    })
    expect(result).toEqual({
      changedFiles: [],
      fixed: [],
      notes: ['package.json not found; nothing fixed'],
    })
  })

  test('restores both files when the package manager fails', async () => {
    const dir = await project({ 'package.json': '{}\n', 'package-lock.json': '{"a":1}' })
    const { runner } = createFakeRunner(async (_, { cwd }) => {
      await Bun.write(join(cwd, 'package-lock.json'), 'broken')
      return { exitCode: 1, stderr: 'ERESOLVE' }
    })
    const error = await jsFixer({ runner })
      .fix({ dir, source: 'package-lock.json', findings: [qs('package-lock.json')] })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CommandError)
    expect(await Bun.file(join(dir, 'package.json')).text()).toBe('{}\n')
    expect(await Bun.file(join(dir, 'package-lock.json')).text()).toBe('{"a":1}')
  })
})
