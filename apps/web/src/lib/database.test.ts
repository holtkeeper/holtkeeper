import { describe, expect, test } from 'bun:test'

import type { DatabaseSession, DatabaseTable } from '@holtkeeper/api'

import {
  deadShare,
  filterSessions,
  formatPercent,
  formatQueryMs,
  growthSince,
  sessionAge,
  sortTables,
} from './database.ts'

const now = new Date('2026-10-31T12:00:00.000Z')

const table = (
  name: string,
  totalBytes: number,
  rows: number,
  deadRows?: number,
): DatabaseTable => ({
  name,
  rows,
  dataBytes: totalBytes,
  indexBytes: 0,
  toastBytes: 0,
  totalBytes,
  ...(deadRows !== undefined && { deadRows }),
})

const session = (
  pid: number,
  state: string,
  extra: Partial<DatabaseSession> = {},
): DatabaseSession => ({
  pid,
  state,
  blockedBy: [],
  ...extra,
})

describe('formatting', () => {
  test('percent keeps two decimals just below 100%', () => {
    expect(formatPercent(0.9997)).toBe('99.97%')
    expect(formatPercent(0.92)).toBe('92.0%')
    expect(formatPercent(1)).toBe('100.0%')
  })

  test('statement times', () => {
    expect(formatQueryMs(0.123)).toBe('0.12 ms')
    expect(formatQueryMs(850.4)).toBe('850 ms')
    expect(formatQueryMs(4_400)).toBe('4.4 s')
    expect(formatQueryMs(12_400)).toBe('12 s')
    expect(formatQueryMs(185_000)).toBe('3 min 5 s')
  })
})

describe('tables', () => {
  test('dead share counts dead rows against all rows', () => {
    expect(deadShare(table('a', 1, 75, 25))).toBe(0.25)
    expect(deadShare(table('a', 1, 0))).toBe(0)
  })

  test('sort by size, rows or dead share and filter by name', () => {
    const tables = [table('jobs', 10, 5, 5), table('kv', 30, 1), table('library_chunks', 20, 50)]
    expect(sortTables(tables, 'size').map((t) => t.name)).toEqual(['kv', 'library_chunks', 'jobs'])
    expect(sortTables(tables, 'rows').map((t) => t.name)).toEqual(['library_chunks', 'jobs', 'kv'])
    expect(sortTables(tables, 'dead').map((t) => t.name)).toEqual(['jobs', 'kv', 'library_chunks'])
    expect(sortTables(tables, 'size', ' LIB ').map((t) => t.name)).toEqual(['library_chunks'])
  })
})

describe('sessions', () => {
  const sessions = [
    session(1, 'idle', { queryStartedAt: '2026-10-31T10:00:00.000Z' }),
    session(2, 'active', { queryStartedAt: '2026-10-31T11:59:58.000Z' }),
    session(3, 'idle in transaction', { transactionStartedAt: '2026-10-31T11:59:00.000Z' }),
  ]

  test('age is the running statement or the open transaction', () => {
    expect(sessions.map((s) => sessionAge(s, now))).toEqual([undefined, 2000, 60_000])
  })

  test('busy hides idle sessions; longest-running first', () => {
    expect(filterSessions(sessions, 'busy', now).map((s) => s.pid)).toEqual([3, 2])
    expect(filterSessions(sessions, 'all', now).map((s) => s.pid)).toEqual([3, 2, 1])
  })
})

describe('growthSince', () => {
  test('compares with the latest snapshot at least a week old', () => {
    const history = [
      { day: '2026-10-20', bytes: 10, domains: {} },
      { day: '2026-10-24', bytes: 40, domains: {} },
      { day: '2026-10-28', bytes: 90, domains: {} },
    ]
    expect(growthSince(history, 100, 7, now)).toBe(60)
    expect(growthSince(history.slice(2), 100, 7, now)).toBeUndefined()
  })
})
