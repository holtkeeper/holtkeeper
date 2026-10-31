import { describe, expect, test } from 'bun:test'

import type { LibraryRecord, LibraryVersionRecord } from '@holtkeeper/store'
import { memoryStore } from '@holtkeeper/store/memory'

import {
  libraryProgress,
  libraryProgressWriter,
  librarySourceCoverage,
} from '../src/library-progress.ts'

const at = '2026-10-31T12:00:00.000Z'
const status = (value: 'ok' | 'missing' | 'failed' | 'skipped') => ({ status: value, at })

const library = (sources: LibraryRecord['sources'] = {}): LibraryRecord => ({
  ecosystem: 'npm',
  name: 'zod',
  sources,
  updatedAt: at,
})

const version = (
  name: string,
  sources: LibraryVersionRecord['sources'],
  roles: LibraryVersionRecord['roles'] = ['used'],
): LibraryVersionRecord => ({
  ecosystem: 'npm',
  name: 'zod',
  version: name,
  roles,
  usedBy: [],
  sources,
  updatedAt: at,
})

describe('librarySourceCoverage', () => {
  test('counts matrix versions per source and libraries for issues', () => {
    const coverage = librarySourceCoverage([
      {
        library: library({ issues: status('ok') }),
        versions: [
          version('4.0.0', {
            archive: status('ok'),
            api: status('ok'),
            repository: status('failed'),
          }),
          version('3.0.0', { archive: status('ok'), api: status('missing') }),
          version('2.0.0', { archive: status('failed') }, []),
        ],
      },
      { library: { ...library(), name: 'react' }, versions: [] },
    ])
    expect(coverage).toEqual([
      { source: 'archive', ok: 2, missing: 0, failed: 0, skipped: 0, pending: 0 },
      { source: 'api', ok: 1, missing: 1, failed: 0, skipped: 0, pending: 0 },
      { source: 'repository', ok: 0, missing: 0, failed: 1, skipped: 0, pending: 1 },
      { source: 'releases', ok: 0, missing: 0, failed: 0, skipped: 0, pending: 2 },
      { source: 'issues', ok: 1, missing: 0, failed: 0, skipped: 0, pending: 1 },
    ])
  })
})

describe('libraryProgressWriter', () => {
  test('writes the first and last state at once and the rest at most every interval', async () => {
    const store = memoryStore()
    let clock = Date.parse(at)
    const writer = libraryProgressWriter({
      kv: store.kv,
      now: () => new Date(clock),
      intervalMs: 3_000,
    })
    writer.update({ total: 10, done: 0, library: 'npm:a' })
    await Bun.sleep(1)
    expect(await libraryProgress(store.kv)).toMatchObject({ total: 10, done: 0, library: 'npm:a' })
    clock += 1_000
    writer.update({ total: 10, done: 1, library: 'npm:b' })
    await Bun.sleep(1)
    expect((await libraryProgress(store.kv))?.done).toBe(0)
    clock += 3_000
    writer.update({ total: 10, done: 2, library: 'npm:c' })
    writer.waiting(new Date(clock + 60_000))
    await Bun.sleep(1)
    expect(await libraryProgress(store.kv)).toMatchObject({
      done: 2,
      library: 'npm:c',
      waitingUntil: new Date(clock + 60_000).toISOString(),
      startedAt: at,
    })
    writer.update({ total: 10, done: 10 })
    await Bun.sleep(1)
    expect((await libraryProgress(store.kv))?.library).toBeUndefined()
    await writer.clear()
    expect(await libraryProgress(store.kv)).toBeUndefined()
  })
})
