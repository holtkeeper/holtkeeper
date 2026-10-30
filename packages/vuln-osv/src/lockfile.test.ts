import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fillResolved, withResolvedLockfiles } from './lockfile.ts'

describe('fillResolved', () => {
  test('fills registry packages of a v2+ lockfile only', () => {
    const lock = {
      packages: {
        '': { name: 'app', dependencies: { lodash: '4.17.15' } },
        'packages/web': { name: 'web', version: '1.0.0' },
        'node_modules/web': { resolved: 'packages/web', link: true },
        'node_modules/lodash': { version: '4.17.15' },
        'node_modules/@scope/pkg': { version: '1.2.3' },
        'node_modules/a/node_modules/ws': { version: '6.2.3' },
        'node_modules/alias': { name: 'real', version: '2.0.0' },
        'node_modules/local': { version: 'file:../local' },
        'node_modules/kept': { version: '1.0.0', resolved: 'https://example.com/kept.tgz' },
      },
    }

    expect(fillResolved(lock)).toBe(4)
    expect(lock.packages['node_modules/lodash']).toHaveProperty(
      'resolved',
      'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz',
    )
    expect(lock.packages['node_modules/@scope/pkg']).toHaveProperty(
      'resolved',
      'https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz',
    )
    expect(lock.packages['node_modules/a/node_modules/ws']).toHaveProperty(
      'resolved',
      'https://registry.npmjs.org/ws/-/ws-6.2.3.tgz',
    )
    expect(lock.packages['node_modules/alias']).toHaveProperty(
      'resolved',
      'https://registry.npmjs.org/real/-/real-2.0.0.tgz',
    )
    expect(lock.packages['packages/web']).not.toHaveProperty('resolved')
    expect(lock.packages['node_modules/local']).not.toHaveProperty('resolved')
    expect(lock.packages['node_modules/kept'].resolved).toBe('https://example.com/kept.tgz')
  })

  test('fills nested dependencies of a v1 lockfile', () => {
    const lock = {
      dependencies: {
        a: {
          version: '1.0.0',
          requires: { ws: '6.2.3' },
          dependencies: { ws: { version: '6.2.3' } },
        },
        gitdep: { version: 'github:org/gitdep#abc' },
      },
    }

    expect(fillResolved(lock)).toBe(2)
    expect(lock.dependencies.a.dependencies.ws).toHaveProperty(
      'resolved',
      'https://registry.npmjs.org/ws/-/ws-6.2.3.tgz',
    )
    expect(lock.dependencies.gitdep).not.toHaveProperty('resolved')
  })
})

describe('withResolvedLockfiles', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holtkeeper-lockfile-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const lock = JSON.stringify({
    packages: {
      '': { dependencies: { lodash: '4.17.15' } },
      'node_modules/lodash': { version: '4.17.15' },
    },
  })
  const read = (path: string) => Bun.file(join(dir, path)).text()

  test('patches lockfiles during the scan and restores them byte for byte', async () => {
    await mkdir(join(dir, 'web'))
    await mkdir(join(dir, 'node_modules/dep'), { recursive: true })
    await writeFile(join(dir, 'web/package-lock.json'), lock)
    await writeFile(join(dir, 'node_modules/dep/package-lock.json'), lock)

    const during = await withResolvedLockfiles(dir, () => read('web/package-lock.json'))

    expect(JSON.parse(during).packages['node_modules/lodash'].resolved).toBe(
      'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz',
    )
    expect(await read('web/package-lock.json')).toBe(lock)
  })

  test('leaves complete and unreadable lockfiles alone and restores after a failed scan', async () => {
    await writeFile(join(dir, 'package-lock.json'), lock)
    await writeFile(join(dir, 'npm-shrinkwrap.json'), 'not json')

    const scan = withResolvedLockfiles(dir, async () => {
      expect(await read('npm-shrinkwrap.json')).toBe('not json')
      throw new Error('scan failed')
    })

    expect(scan).rejects.toThrow('scan failed')
    await scan.catch(() => {})
    expect(await read('package-lock.json')).toBe(lock)
  })
})
