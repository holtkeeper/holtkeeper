import { describe, expect, test } from 'bun:test'

import {
  auditActionLabel,
  auditActorKind,
  auditDays,
  auditScopeLabel,
  auditStripCounts,
  chainStatus,
  formatClock,
  formatSeq,
} from './audit-labels.ts'

const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString()

describe('auditActionLabel', () => {
  test('reads known actions as sentences', () => {
    expect(auditActionLabel('credential.rotate')).toBe('Rotated a credential')
    expect(auditActionLabel('audit.verify')).toBe('Verified the hash chain')
    expect(auditActionLabel('setting.draft')).toBe('Saved several setting changes')
    expect(auditActionLabel('user.invite')).toBe('Sent an invite again')
    expect(auditActionLabel('user.recovery')).toBe('Issued a recovery link')
  })

  test('falls back on the verb and the object', () => {
    expect(auditActionLabel('trigger.update')).toBe('Changed a trigger')
    expect(auditActionLabel('egress_rule.create')).toBe('Added an egress rule')
    expect(auditActionLabel('widget_policy.run')).toBe('Widget policy run')
    expect(auditActionLabel('ping')).toBe('Ping')
  })
})

describe('actors, scopes and numbers', () => {
  test('tell people, agents and the system apart', () => {
    expect(auditActorKind({ id: 'u1', name: 'Mira K.', provider: 'users' })).toBe('person')
    expect(auditActorKind({ id: 'agent:learning', name: 'Agent', provider: 'users' })).toBe('agent')
    expect(auditActorKind({ id: 'system', name: 'scheduler', provider: 'job' })).toBe('system')
    expect(auditActorKind({ id: 'gitlab:work:42', name: 'bot', provider: 'job' })).toBe('system')
  })

  test('name the repository or the organization', () => {
    expect(auditScopeLabel({ target: { type: 'release', repo: 'work:acme/widget-kit' } })).toBe(
      'work:acme/widget-kit',
    )
    expect(auditScopeLabel({ target: { type: 'credential', id: 'c1' } })).toBe('Organization')
  })

  test('format sequence numbers and clock times', () => {
    expect(formatSeq(48210)).toBe('#48,210')
    expect(formatClock(at(2026, 10, 11, 9, 5))).toBe('09:05')
  })
})

describe('auditDays', () => {
  test('groups events by local day with Today, Yesterday and weekdays', () => {
    const now = new Date(2026, 10, 11, 15, 0)
    const days = auditDays(
      [
        { at: at(2026, 10, 11, 14, 41) },
        { at: at(2026, 10, 11, 0, 5) },
        { at: at(2026, 10, 10, 18, 22) },
        { at: at(2026, 10, 8, 9, 0) },
        { at: at(2026, 10, 1, 9, 0) },
        { at: at(2025, 11, 31, 9, 0) },
      ],
      now,
    )
    expect(days.map((day) => [day.title, day.date, day.events.length])).toEqual([
      ['Today', 'Wednesday, Nov 11', 2],
      ['Yesterday', 'Tuesday, Nov 10', 1],
      ['Sunday', 'Sunday, Nov 8', 1],
      ['Nov 1', 'Sunday, Nov 1', 1],
      ['Dec 31, 2025', 'Wednesday, Dec 31, 2025', 1],
    ])
    expect(days[0]?.key).toBe('2026-11-11')
  })
})

describe('auditStripCounts', () => {
  test('counts people and agents and notes the system', () => {
    expect(
      auditStripCounts(
        {
          total: 12,
          actors: [
            { key: 'u1', name: 'Mira K.', count: 5 },
            { key: 'u2', name: 'Teo R.', count: 3 },
            { key: 'agent:learning', name: 'Agent', count: 2 },
            { key: 'system', name: 'System', count: 2 },
          ],
        },
        3,
        1,
      ),
    ).toEqual({ total: 12, denied: 3, failed: 1, people: 2, agents: 1, system: true })
  })
})

describe('chainStatus', () => {
  const last = {
    at: at(2026, 10, 11, 14, 0),
    result: { ok: true, checked: 48206, firstSeq: 1, lastSeq: 48206 },
  }

  test('says the chain is intact and how many events wait', () => {
    expect(chainStatus(last, 48212)).toEqual({
      tone: 'success',
      title: 'Chain intact',
      detail:
        '48,206 events checked #1–#48,206 · checked daily, last at 14:00 · 6 newer events wait for the next check',
    })
    expect(chainStatus(last, 48206).detail).toBe(
      '48,206 events checked #1–#48,206 · checked daily, last at 14:00',
    )
  })

  test('names the first broken event and prefers a check run by hand', () => {
    const broken = chainStatus(last, undefined, {
      ok: false,
      checked: 10,
      firstSeq: 1,
      lastSeq: 10,
      broken: { seq: 7, id: 'e7', reason: 'link' },
    })
    expect(broken.tone).toBe('danger')
    expect(broken.title).toBe('Chain broken at #7')
    expect(broken.detail).toBe(
      'it does not link to the event before it; 10 events checked #1–#10 · checked just now',
    )
  })

  test('is quiet before the first check', () => {
    expect(chainStatus({}, 5)).toEqual({
      tone: 'default',
      title: 'Not checked yet',
      detail: 'The chain is checked daily.',
    })
  })
})
