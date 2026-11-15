import { expect, test } from 'bun:test'

import { memoryStore } from '@holtkeeper/store/memory'

import type { SecretReportInput } from './model.ts'
import { secretReportStore } from './store.ts'

const input: SecretReportInput = {
  kind: 'api-key',
  identifier: 'WIDGET_API_KEY',
  service: 'api.example.com',
  masked: 'wk_l…(40)',
  channel: 'chat',
}

const at = new Date('2026-03-04T15:16:17.000Z')

test('named reports keep the reporter and the exact time', async () => {
  const reports = secretReportStore({ kv: memoryStore().kv!, now: () => at })
  const { status, report } = await reports.submit(input, { id: 'u1', name: 'Kim' })
  expect(status).toBe('reported')
  expect(report).toMatchObject({
    ...input,
    status: 'new',
    reportedAt: at.toISOString(),
    reporter: { id: 'u1', name: 'Kim' },
    repeats: 0,
  })
})

test('anonymous reports keep only the day and nothing about the sender', async () => {
  const reports = secretReportStore({ kv: memoryStore().kv!, now: () => at })
  const { report } = await reports.submit(input)
  expect(report.reportedAt).toBe('2026-03-04T00:00:00.000Z')
  expect(report.reporter).toBeUndefined()
  expect(Object.keys(report)).not.toContain('reporter')
})

test('the same open exposure counts as a repeat; a closed one is reported again', async () => {
  const reports = secretReportStore({ kv: memoryStore().kv!, now: () => at })
  const first = await reports.submit(input, { id: 'u1', name: 'Kim' })
  const again = await reports.submit({ ...input, identifier: 'widget_api_key' })
  expect(again.status).toBe('repeated')
  expect(again.report.id).toBe(first.report.id)
  expect(again.report.repeats).toBe(1)
  expect(again.report.reporter).toEqual({ id: 'u1', name: 'Kim' })

  await reports.update(first.report.id, { status: 'rotated', note: 'Rotated' }, 'admin')
  const later = await reports.submit(input)
  expect(later.status).toBe('reported')
  expect(await reports.list()).toHaveLength(2)
})

test('update changes status and note and records the administrator', async () => {
  const reports = secretReportStore({ kv: memoryStore().kv!, now: () => at })
  const { report } = await reports.submit(input)
  const updated = await reports.update(report.id, { status: 'acknowledged', note: ' on it ' }, 'a1')
  expect(updated).toMatchObject({ status: 'acknowledged', note: 'on it', updatedBy: 'a1' })
  expect((await reports.update(report.id, { note: '' }, 'a1'))?.note).toBeUndefined()
  expect(await reports.update('missing', { status: 'rotated' }, 'a1')).toBeUndefined()
  expect(await reports.get(report.id)).toMatchObject({ status: 'acknowledged' })
})

test('the oldest closed reports go first beyond the limit', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z')
  const reports = secretReportStore({ kv: memoryStore().kv!, now: () => now, limit: 2 })
  const old = await reports.submit({ ...input, identifier: 'A' }, { id: 'u', name: 'u' })
  await reports.update(old.report.id, { status: 'rotated' }, 'a')
  now = new Date('2026-01-02T00:00:00.000Z')
  const open = await reports.submit({ ...input, identifier: 'B' }, { id: 'u', name: 'u' })
  now = new Date('2026-01-03T00:00:00.000Z')
  await reports.submit({ ...input, identifier: 'C' }, { id: 'u', name: 'u' })
  const kept = (await reports.list()).map((report) => report.identifier)
  expect(kept).toEqual(['C', 'B'])
  expect(open.report.identifier).toBe('B')
})
