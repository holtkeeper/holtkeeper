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

  test('says once who holds a busy lock', async () => {
    const mirror = await mirrorIn()
    await writeFile(`${mirror}.lock`, 'busy-host 42 x')
    const lines: string[] = []
    setTimeout(() => void rm(`${mirror}.lock`, { force: true }), 60)
    await withMirrorLock(mirror, async () => {}, { pollMs: 5, log: (line) => lines.push(line) })
    expect(lines).toEqual(['waiting for the mirror lock held by busy-host pid 42'])
  })

  test('a holder that hangs stops refreshing the lock so others take it over', async () => {
    const mirror = await mirrorIn()
    const lines: string[] = []
    const { promise: holding, resolve: release } = Promise.withResolvers<void>()
    const hung = withMirrorLock(mirror, () => holding, {
      refreshMs: 10,
      maxHoldMs: 40,
      log: (line) => lines.push(line),
    })
    const next = await withMirrorLock(mirror, async () => 'ran', { pollMs: 5, staleMs: 100 })
    expect(next).toBe('ran')
    expect(lines.some((line) => line.includes('no longer refreshing'))).toBeTrue()
    release()
    await hung
  })

  test('takes over a lock with a future mtime that nobody refreshes', async () => {
    // What an exclusive create on NFS leaves when its process dies at once: no owner, and the
    // create verifier as timestamps.
    const mirror = await mirrorIn()
    await writeFile(`${mirror}.lock`, '')
    const future = new Date('2035-04-07T15:28:39Z')
    await utimes(`${mirror}.lock`, future, future)
    const lines: string[] = []
    const started = Date.now()
    const ran = await withMirrorLock(mirror, async () => 'ran', {
      pollMs: 5,
      staleMs: 100,
      log: (line) => lines.push(line),
    })
    expect(ran).toBe('ran')
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    expect(lines.some((line) => line.startsWith('taking over the stale mirror lock'))).toBeTrue()
  })

  test('keeps waiting for a lock its holder refreshes, whatever its clock says', async () => {
    const mirror = await mirrorIn()
    await writeFile(`${mirror}.lock`, 'skewed-host 7 x')
    let tick = 0
    const refresh = setInterval(() => {
      const ahead = new Date(Date.now() + 3_600_000 + ++tick * 1000)
      void utimes(`${mirror}.lock`, ahead, ahead)
    }, 20)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 400)
    const outcome = await withMirrorLock(mirror, async () => 'ran', {
      pollMs: 5,
      staleMs: 100,
      signal: controller.signal,
    }).catch(() => 'still waiting')
    clearInterval(refresh)
    expect(outcome).toBe('still waiting')
  })
})
