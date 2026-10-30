import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectPackageManager, lockfileKind, lockfileUpdateCommand } from './manager.ts'

const dirs: string[] = []
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hk-vuln-js-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('lockfileKind', () => {
  test('recognizes lockfiles by basename', () => {
    expect(lockfileKind('bun.lock')).toBe('bun')
    expect(lockfileKind('apps/web/pnpm-lock.yaml')).toBe('pnpm')
    expect(lockfileKind('yarn.lock')).toBe('yarn')
    expect(lockfileKind('sub/package-lock.json')).toBe('npm')
  })

  test('rejects other files', () => {
    expect(lockfileKind('bun.lockb')).toBeUndefined()
    expect(lockfileKind('package.json')).toBeUndefined()
    expect(lockfileKind('go.sum')).toBeUndefined()
  })
})

describe('detectPackageManager', () => {
  test('maps non-yarn lockfiles directly', async () => {
    expect(await detectPackageManager('pnpm', '/nonexistent')).toBe('pnpm')
  })

  test('uses packageManager for yarn', async () => {
    const dir = await tempDir()
    expect(await detectPackageManager('yarn', dir, 'yarn@4.5.0')).toBe('yarn-berry')
    expect(await detectPackageManager('yarn', dir, 'yarn@1.22.22')).toBe('yarn-classic')
  })

  test('falls back to .yarnrc.yml for yarn', async () => {
    const dir = await tempDir()
    expect(await detectPackageManager('yarn', dir)).toBe('yarn-classic')
    await Bun.write(join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
    expect(await detectPackageManager('yarn', dir)).toBe('yarn-berry')
  })
})

describe('lockfileUpdateCommand', () => {
  test('never runs lifecycle scripts', () => {
    expect(lockfileUpdateCommand('npm')).toEqual([
      'npm',
      'install',
      '--package-lock-only',
      '--ignore-scripts',
    ])
    expect(lockfileUpdateCommand('bun')).toEqual([
      'bun',
      'install',
      '--lockfile-only',
      '--ignore-scripts',
    ])
    expect(lockfileUpdateCommand('pnpm')).toEqual([
      'pnpm',
      'install',
      '--lockfile-only',
      '--ignore-scripts',
    ])
    expect(lockfileUpdateCommand('yarn-berry')).toEqual([
      'yarn',
      'install',
      '--mode=update-lockfile',
    ])
    expect(lockfileUpdateCommand('yarn-classic')).toEqual(['yarn', 'install', '--ignore-scripts'])
  })
})
