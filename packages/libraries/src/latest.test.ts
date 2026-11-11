import { describe, expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import { latestVersions, majorsBehind } from './latest.ts'

const kvOf = () => {
  const kv = memoryStore().kv
  if (!kv) throw new Error('memory store has no kv')
  return kv
}

describe('latestVersions', () => {
  test('merges entries and drops the ones not kept', async () => {
    const latest = latestVersions(kvOf())
    await latest.record([
      { ecosystem: 'npm', name: 'widget-kit', latest: '3.1.0', checkedAt: 'a' },
      { ecosystem: 'Go', name: 'example.com/shapes', latest: 'v2.4.0', checkedAt: 'a' },
    ])
    await latest.record(
      [{ ecosystem: 'npm', name: 'widget-kit', latest: '3.2.0', checkedAt: 'b' }],
      new Set(['npm:widget-kit']),
    )
    expect(await latest.get({ ecosystem: 'npm', name: 'widget-kit' })).toEqual({
      latest: '3.2.0',
      checkedAt: 'b',
    })
    expect(await latest.get({ ecosystem: 'Go', name: 'example.com/shapes' })).toBeUndefined()
    expect([...(await latest.all()).keys()]).toEqual(['npm:widget-kit'])
  })

  test('ignores malformed stored values', async () => {
    const kv = kvOf()
    await kv.set('libraries:latest', { 'npm:a': { latest: 1 }, 'npm:b': 'x' })
    expect((await latestVersions(kv).all()).size).toBe(0)
  })
})

describe('majorsBehind', () => {
  test('counts majors, and minors below 1.0', () => {
    expect(majorsBehind('1.4.0', '3.0.1')).toBe(2)
    expect(majorsBehind('v1.2.0', 'v2.0.0')).toBe(1)
    expect(majorsBehind('0.3.0', '0.5.2')).toBe(2)
    expect(majorsBehind('0.9.0', '2.0.0')).toBe(2)
    expect(majorsBehind('2.1.0', '2.9.0')).toBe(0)
    expect(majorsBehind('3.0.0', '2.0.0')).toBe(0)
    expect(majorsBehind('main', '2.0.0')).toBe(0)
  })
})
