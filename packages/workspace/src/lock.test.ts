import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withMirrorLock } from './lock.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const mirrorIn = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-lock-'))
  dirs.push(dir)
  return join(dir, 'repo.git')
}

describe('withMirrorLock', () => {
  test('runs holders of one mirror one after another', async () => {
    const mirror = await mirrorIn()
    const events: string[] = []
    const hold = (name: string) =>
      withMirrorLock(
        mirror,
        async () => {
          events.push(`${name} in`)
          await Bun.sleep(30)
          events.push(`${name} out`)
        },
        { pollMs: 5 },
      )
    await Promise.all([hold('a'), hold('b')])
    expect(events).toHaveLength(4)
    expect(events[1]).toBe(events[0]?.replace('in', 'out'))
  })

  test('takes over a stale lock and removes leftover git locks', async () => {
    const mirror = await mirrorIn()
    await mkdir(join(mirror, 'refs', 'heads'), { recursive: true })
    await writeFile(join(mirror, 'packed-refs.lock'), '')
    await writeFile(join(mirror, 'refs', 'heads', 'main.lock'), '')
    await writeFile(`${mirror}.lock`, 'dead-host 1 x')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(`${mirror}.lock`, old, old)

    const seen = await withMirrorLock(mirror, async () => ({
      packed: await Bun.file(join(mirror, 'packed-refs.lock')).exists(),
      ref: await Bun.file(join(mirror, 'refs', 'heads', 'main.lock')).exists(),
    }))
    expect(seen).toEqual({ packed: false, ref: false })
    expect(await Bun.file(`${mirror}.lock`).exists()).toBeFalse()
  })

  test('waits for a live lock and gives up when aborted', async () => {
    const mirror = await mirrorIn()
    await writeFile(`${mirror}.lock`, 'busy-host 1 x')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const outcome = await withMirrorLock(mirror, async () => 'ran', {
      pollMs: 5,
      signal: controller.signal,
    }).catch(() => 'aborted')
    expect(outcome).toBe('aborted')
  })
})
