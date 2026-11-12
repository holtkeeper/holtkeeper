import { describe, expect, test } from 'bun:test'

import type { SettingEntry } from '@holtkeeper/store'

import { mergeRequestComments } from './definitions.ts'
import { resolveMergeRequestComments } from './merge-request-comments.ts'

const widget = { forge: 'acme', path: 'shapes/widget', groups: ['shapes'] }
const core = { forge: 'acme', path: 'shapes/widget-core', groups: ['shapes'] }

const entry = (
  id: string,
  scope: SettingEntry['scope'],
  value: unknown,
  secret = false,
): SettingEntry => ({
  id,
  key: 'mergeRequests.comments',
  scope,
  value,
  secret,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

describe('mergeRequests.comments', () => {
  test('on without an entry', () => {
    expect(resolveMergeRequestComments([], widget)).toEqual({ enabled: true })
    expect(mergeRequestComments.default).toEqual({ enabled: true })
  })

  test('a group turns it off and a repository entry turns it back on', () => {
    const group = entry('g', { groups: ['shapes'] }, { enabled: false, reason: 'Team opted out' })
    const own = entry('r', { repos: ['shapes/widget-core'] }, { enabled: true })
    expect(resolveMergeRequestComments([group, own], widget)).toEqual({
      enabled: false,
      reason: 'Team opted out',
      entry: group,
    })
    expect(resolveMergeRequestComments([group, own], core)).toEqual({ enabled: true, entry: own })
  })

  test('invalid and secret values count as the default', () => {
    expect(resolveMergeRequestComments([entry('a', { all: true }, false)], widget)).toEqual({
      enabled: true,
    })
    expect(
      resolveMergeRequestComments([entry('s', { all: true }, { enabled: false }, true)], widget),
    ).toEqual({ enabled: true })
  })
})
