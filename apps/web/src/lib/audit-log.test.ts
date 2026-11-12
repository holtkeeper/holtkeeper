import { describe, expect, test } from 'bun:test'

import type { AuditEvent, HistoryScope } from '@holtkeeper/api'

import {
  actionLabel,
  auditEventMatches,
  changeValue,
  emptyHistoryFilters,
  historyQueryOf,
  outcomeLabel,
  outcomeTone,
  scopeRepos,
  targetLabel,
} from './audit-log.ts'

const now = new Date('2026-10-30T12:00:00.000Z')

const scope: HistoryScope = {
  repos: [
    { repo: 'work:shop/web', groups: ['shop', 'frontend'] },
    { repo: 'work:shop/api', groups: ['shop'] },
    { repo: 'work:tools/cli', groups: ['tools'] },
  ],
  instance: false,
}

describe('scopeRepos', () => {
  test('narrows to the home groups, their complement, or nothing', () => {
    expect(scopeRepos('all', scope, ['shop'])).toBeUndefined()
    expect(scopeRepos('mine', undefined, ['shop'])).toBeUndefined()
    expect(scopeRepos('mine', scope, ['shop'])).toEqual(['work:shop/web', 'work:shop/api'])
    expect(scopeRepos('mine', scope, [['shop', 'frontend']])).toEqual(['work:shop/web'])
    expect(scopeRepos('mine', scope, [])).toEqual([])
  })
})

describe('historyQueryOf', () => {
  test('the default looks back 7 days and sends nothing else', () => {
    expect(historyQueryOf(emptyHistoryFilters, undefined, now)).toEqual({
      from: '2026-10-23T12:00:00.000Z',
    })
  })

  test('maps every filter; a picked repository wins over the scope', () => {
    expect(
      historyQueryOf(
        { actor: 'u1', area: 'release', repo: '', outcome: 'error', range: '24h' },
        ['work:a/b', 'work:c/d'],
        now,
      ),
    ).toEqual({
      actor: 'u1',
      action: 'release',
      outcome: 'error',
      repos: 'work:a/b,work:c/d',
      from: '2026-10-29T12:00:00.000Z',
    })
    expect(
      historyQueryOf({ ...emptyHistoryFilters, repo: 'work:x/y', range: 'all' }, ['work:a/b'], now),
    ).toEqual({ repos: 'work:x/y' })
    expect(historyQueryOf({ ...emptyHistoryFilters, range: 'all' }, [], now)).toEqual({
      repos: '',
    })
  })
})

describe('presentation', () => {
  test('labels actions, outcomes, targets and change values', () => {
    expect(actionLabel('repo.webhook_create')).toBe('repo webhook create')
    expect(outcomeTone('ok')).toBe('success')
    expect(outcomeTone('denied')).toBe('warning')
    expect(outcomeTone('error')).toBe('danger')
    expect(['ok', 'denied', 'error'].map(outcomeLabel)).toEqual(['Succeeded', 'Denied', 'Failed'])
    expect(targetLabel({ type: 'credential', id: 'abc' })).toBe('credential:abc')
    expect(targetLabel({ type: 'release', repo: 'work:shop/web' })).toBe('work:shop/web')
    expect(targetLabel({ type: 'settings' })).toBe('settings')
    expect(changeValue(undefined)).toBe('—')
    expect(changeValue('«redacted»')).toBe('«redacted»')
    expect(changeValue({ a: 1 })).toBe('{"a":1}')
    expect(changeValue(false)).toBe('false')
  })
})

describe('auditEventMatches', () => {
  const event = {
    id: '7c1e09aa-0000-4000-8000-000000000001',
    seq: 4182,
    action: 'setting.put',
    target: { type: 'setting', id: 'analyzers.widget' },
  } as AuditEvent

  test('matches action, target, sequence number and id prefix', () => {
    expect(auditEventMatches(event, '')).toBe(true)
    expect(auditEventMatches(event, 'widget setting')).toBe(true)
    expect(auditEventMatches(event, '#4,182')).toBe(true)
    expect(auditEventMatches(event, '4182')).toBe(true)
    expect(auditEventMatches(event, '7c1e09')).toBe(true)
    expect(auditEventMatches(event, 'gadget')).toBe(false)
    expect(auditEventMatches(event, '418')).toBe(false)
  })
})
