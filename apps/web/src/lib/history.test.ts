import { describe, expect, test } from 'bun:test'

import type { HistoryScope } from '@holtkeeper/api'

import {
  actionLabel,
  changeValue,
  emptyHistoryFilters,
  historyQueryOf,
  outcomeTone,
  scopeRepos,
  targetLabel,
  verificationSummary,
} from './history.ts'

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
    expect(scopeRepos('others', scope, ['shop'])).toEqual(['work:tools/cli'])
    expect(scopeRepos('mine', scope, [])).toEqual([])
  })
})

describe('historyQueryOf', () => {
  test('the default looks back 30 days and sends nothing else', () => {
    expect(historyQueryOf(emptyHistoryFilters, undefined, now)).toEqual({
      from: '2026-09-30T12:00:00.000Z',
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
    expect(targetLabel({ type: 'credential', id: 'abc' })).toBe('credential:abc')
    expect(targetLabel({ type: 'release', repo: 'work:shop/web' })).toBe('work:shop/web')
    expect(targetLabel({ type: 'settings' })).toBe('settings')
    expect(changeValue(undefined)).toBe('—')
    expect(changeValue('«redacted»')).toBe('«redacted»')
    expect(changeValue({ a: 1 })).toBe('{"a":1}')
    expect(changeValue(false)).toBe('false')
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
