import { describe, expect, test } from 'bun:test'

import type { AuditEvent } from '@holtkeeper/api'

import {
  activeFilters,
  auditQueryOf,
  changeValue,
  emptyAuditForm,
  hasDetails,
  outcomeTone,
  statusClass,
  targetLabel,
  verificationSummary,
} from './audit-log.ts'

describe('auditQueryOf', () => {
  test('drops empty fields', () => {
    expect(auditQueryOf(emptyAuditForm)).toEqual({})
  })

  test('trims text and turns days into an inclusive range', () => {
    expect(
      auditQueryOf({
        ...emptyAuditForm,
        actor: '  jane ',
        action: 'credential',
        outcome: 'denied',
        fromDay: '2026-10-01',
        toDay: '2026-10-31',
      }),
    ).toEqual({
      actor: 'jane',
      action: 'credential',
      outcome: 'denied',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    })
  })

  test('ignores malformed days', () => {
    expect(auditQueryOf({ ...emptyAuditForm, fromDay: '2026-10', toDay: 'x' })).toEqual({})
  })

  test('counts active filters', () => {
    expect(activeFilters({ actor: 'a', via: 'ui', repo: '' })).toBe(2)
  })
})

describe('presentation', () => {
  test('maps outcomes and statuses', () => {
    expect(outcomeTone('ok')).toBe('success')
    expect(outcomeTone('denied')).toBe('warning')
    expect(outcomeTone('error')).toBe('danger')
    expect(statusClass(undefined)).toBe('text-muted')
    expect(statusClass(201)).toBe('text-muted')
    expect(statusClass(404)).toBe('text-warning')
    expect(statusClass(502)).toBe('text-danger')
  })

  test('labels targets and change values', () => {
    expect(targetLabel({ type: 'credential', id: 'abc' })).toBe('credential:abc')
    expect(targetLabel({ type: 'settings' })).toBe('settings')
    expect(changeValue(undefined)).toBe('—')
    expect(changeValue('«redacted»')).toBe('«redacted»')
    expect(changeValue({ a: 1 })).toBe('{"a":1}')
    expect(changeValue(false)).toBe('false')
  })

  test('detects expandable events', () => {
    const event: AuditEvent = {
      id: '1',
      seq: 1,
      prevHash: '0',
      hash: '1',
      at: '2026-10-30T00:00:00Z',
      actor: { id: 'system', name: 'system', provider: 'system' },
      via: 'system',
      action: 'storage.cleared',
      target: { type: 'storage' },
      outcome: 'ok',
    }
    expect(hasDetails(event)).toBe(false)
    expect(hasDetails({ ...event, details: {} })).toBe(false)
    expect(hasDetails({ ...event, details: { removed: 3 } })).toBe(true)
    expect(hasDetails({ ...event, changes: [{ field: 'name', before: 'a', after: 'b' }] })).toBe(
      true,
    )
  })
})

describe('verificationSummary', () => {
  test('reports an intact chain', () => {
    expect(verificationSummary({ ok: true, checked: 12, firstSeq: 1, lastSeq: 12 })).toEqual({
      tone: 'success',
      title: 'Chain intact',
      description: '12 events checked (#1–#12).',
    })
  })

  test('reports where it broke', () => {
    const summary = verificationSummary({
      ok: false,
      checked: 5,
      broken: { seq: 4, id: 'x', reason: 'link' },
    })
    expect(summary.tone).toBe('danger')
    expect(summary.title).toBe('Chain broken at #4')
    expect(summary.description).toBe('it does not link to the event before it; 5 checked.')
  })
})
