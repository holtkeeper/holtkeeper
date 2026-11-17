import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'
import type { OsvClient, OsvPackageQuery, OsvRecord } from '@holtkeeper/vuln-osv'

import { kvRecordCache, matchPackages, packageKey } from './match.ts'

function fakeClient(advisories: Record<string, { modified: string; record: OsvRecord }[]>) {
  const calls = { batches: [] as OsvPackageQuery[][], fetched: [] as string[] }
  const client: OsvClient = {
    async queryBatch(queries) {
      calls.batches.push([...queries])
      return queries.map((query) =>
        (advisories[packageKey(query)] ?? []).map(({ modified, record }) => ({
          id: record.id,
          modified,
        })),
      )
    },
    async vulnerability(id) {
      calls.fetched.push(id)
      for (const list of Object.values(advisories))
        for (const entry of list) if (entry.record.id === id) return entry.record
      return undefined
    },
  }
  return { client, calls }
}

const lib = { ecosystem: 'npm', name: 'some-lib', version: '1.0.0' }
const other = { ecosystem: 'npm', name: 'other-lib', version: '2.0.0' }

describe('matchPackages', () => {
  test('queries each package version once and fetches only new or changed records', async () => {
    const advisory = { id: 'GHSA-aaaa-bbbb-cccc', summary: 'first' }
    const { client, calls } = fakeClient({
      [packageKey(lib)]: [{ modified: '2026-01-01T00:00:00Z', record: advisory }],
      [packageKey(other)]: [{ modified: '2026-01-01T00:00:00Z', record: advisory }],
    })
    const cache = kvRecordCache(memoryStore().kv!)

    const first = await matchPackages({ client, cache, packages: [lib, lib, other] })
    expect(calls.batches).toEqual([[lib, other]])
    expect(calls.fetched).toEqual(['GHSA-aaaa-bbbb-cccc'])
    expect(first.records.get(packageKey(lib))).toEqual([advisory])
    expect(first).toMatchObject({ queried: 2, fetched: 1 })

    const second = await matchPackages({ client, cache, packages: [lib] })
    expect(calls.fetched).toHaveLength(1)
    expect(second.fetched).toBe(0)

    const changed = fakeClient({
      [packageKey(lib)]: [
        { modified: '2026-02-01T00:00:00Z', record: { ...advisory, summary: 'second' } },
      ],
    })
    const third = await matchPackages({ client: changed.client, cache, packages: [lib] })
    expect(changed.calls.fetched).toEqual(['GHSA-aaaa-bbbb-cccc'])
    expect(third.records.get(packageKey(lib))?.[0]?.summary).toBe('second')
  })

  test('leaves out advisories OSV no longer knows and unaffected packages', async () => {
    const client: OsvClient = {
      queryBatch: async (queries) =>
        queries.map(() => [{ id: 'GHSA-gone', modified: '2026-01-01T00:00:00Z' }]),
      vulnerability: async () => undefined,
    }
    const result = await matchPackages({
      client,
      cache: kvRecordCache(memoryStore().kv!),
      packages: [lib],
    })
    expect(result.records.size).toBe(0)
  })
})
