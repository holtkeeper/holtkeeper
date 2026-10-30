import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listMirrors, mirrorStorage, pruneMirrors } from './mirrors.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holtkeeper-mirrors-'))
  await Bun.write(join(dir, 'games-a-111.git/HEAD'), 'ref: refs/heads/main\n')
  await Bun.write(join(dir, 'games-a-111.git/objects/pack/p.pack'), new Uint8Array(100))
  await Bun.write(join(dir, 'games-b-222.git/HEAD'), 'ref: refs/heads/main\n')
  await Bun.write(join(dir, 'games-b-222.git/FETCH_HEAD'), 'x')
  await Bun.write(join(dir, 'stray.txt'), 'ignored')
  const old = new Date('2026-01-01T00:00:00Z')
  await utimes(join(dir, 'games-a-111.git/HEAD'), old, old)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('lists mirrors with sizes and prunes the unused ones', async () => {
  const mirrors = await listMirrors(dir)
  expect(mirrors.map((m) => [m.name, m.bytes])).toEqual([
    ['games-a-111.git', 121],
    ['games-b-222.git', 22],
  ])
  const pruned = await pruneMirrors(dir, {
    unusedForDays: 30,
    now: () => new Date('2026-10-30T00:00:00Z'),
  })
  expect(pruned).toEqual({ removed: ['games-a-111.git'], bytes: 121 })
  expect((await mirrorStorage(dir).usage()).count).toBe(1)
  expect(await mirrorStorage(dir).clear()).toEqual({ removed: 1, bytes: 22 })
  expect(await listMirrors(join(dir, 'missing'))).toEqual([])
})
