import { describe, expect, test } from 'bun:test'

import { newestRecords } from './analyses.ts'
import { memoryStore } from './memory.ts'
import type { AnalysisRecord } from './types.ts'

const add = (path: string, createdAt: string, valid: boolean, kind = 'depgraph') => ({
  repo: { forge: 'work', path },
  kind,
  createdAt,
  ref: createdAt.slice(8, 10),
  data: { valid },
})

const valid = (record: AnalysisRecord) =>
  typeof record.data === 'object' &&
  record.data !== null &&
  'valid' in record.data &&
  record.data.valid
    ? record.ref
    : undefined

describe('newestRecords', () => {
  test('takes the newest accepted record per repository, falling back to older ones', async () => {
    const { analyses } = memoryStore()
    await analyses.add(add('a', '2026-10-01T00:00:00.000Z', true))
    await analyses.add(add('a', '2026-10-02T00:00:00.000Z', true))
    await analyses.add(add('b', '2026-10-01T00:00:00.000Z', true))
    await analyses.add(add('b', '2026-10-03T00:00:00.000Z', false))
    await analyses.add(add('c', '2026-10-04T00:00:00.000Z', false))
    await analyses.add(add('d', '2026-10-05T00:00:00.000Z', true, 'usages'))

    const found = await newestRecords(analyses, 'depgraph', valid)
    expect([...found].map(([key, { value }]) => [key, value])).toEqual([
      ['work:a', '02'],
      ['work:b', '01'],
    ])
    const visible = await newestRecords(analyses, 'depgraph', valid, (r) => r.repo.path !== 'a')
    expect([...visible.keys()]).toEqual(['work:b'])
  })
})
