import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeRunner } from '@holtkeeper/exec/testing'

import { miseCacheSize, miseCacheStorage, parseSize } from './cache.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-mise-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('parses engine sizes', () => {
  expect(parseSize('1.5GB')).toBe(1_500_000_000)
  expect(parseSize('512kB')).toBe(512_000)
  expect(parseSize('2MiB')).toBe(2 * 1024 ** 2)
  expect(parseSize('0B')).toBe(0)
  expect(parseSize('n/a')).toBeUndefined()
})

test('reads the volume size from system df and clears the volume', async () => {
  const { runner, calls } = createFakeRunner((command) =>
    command[1] === 'system'
      ? { stdout: JSON.stringify({ Volumes: [{ Name: 'holtkeeper-mise-cache', Size: '1.2GB' }] }) }
      : undefined,
  )
  const storage = miseCacheStorage({ mode: 'container', hostRunner: runner })
  expect(await storage.usage()).toMatchObject({ bytes: 1_200_000_000 })
  expect(await storage.clear?.()).toEqual({ removed: 1, bytes: 1_200_000_000 })
  expect(calls.at(-1)?.command).toEqual(['docker', 'volume', 'rm', 'holtkeeper-mise-cache'])
})

test('falls back to du and reports a missing volume', async () => {
  const { runner } = createFakeRunner((command) =>
    command[1] === 'run'
      ? { stdout: '2048\t/v\n' }
      : command[1] === 'system'
        ? { exitCode: 1 }
        : undefined,
  )
  expect(await miseCacheSize({ mode: 'container', engine: 'podman', hostRunner: runner })).toBe(
    2048 * 1024,
  )
  const missing = createFakeRunner((command) =>
    command[1] === 'volume' ? { exitCode: 1 } : undefined,
  )
  expect(
    await miseCacheStorage({ mode: 'container', hostRunner: missing.runner }).usage(),
  ).toMatchObject({ available: false })
})

test('measures the host data directory', async () => {
  await Bun.write(join(dir, 'installs/node/bin/node'), new Uint8Array(10))
  const storage = miseCacheStorage({ mode: 'host', dataDir: dir })
  expect((await storage.usage()).bytes).toBe(10)
  expect('clear' in storage).toBe(false)
})
