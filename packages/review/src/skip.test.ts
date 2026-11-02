import { describe, expect, test } from 'bun:test'

import { DEFAULT_RELEASE_BRANCHES, isReleaseMergeRequest, skipReason } from './skip.ts'

const mr = (sourceBranch: string, targetBranch: string, author = 'jane') => ({
  sourceBranch,
  targetBranch,
  author,
})
const defaults = { releaseBranches: DEFAULT_RELEASE_BRANCHES, reviewOwn: false }

describe('isReleaseMergeRequest', () => {
  test('matches release candidates and back-merges, not feature branches', () => {
    expect(isReleaseMergeRequest(mr('develop', 'main'), DEFAULT_RELEASE_BRANCHES)).toBe(true)
    expect(isReleaseMergeRequest(mr('release/2.4', 'master'), DEFAULT_RELEASE_BRANCHES)).toBe(true)
    expect(isReleaseMergeRequest(mr('main', 'develop'), DEFAULT_RELEASE_BRANCHES)).toBe(true)
    expect(isReleaseMergeRequest(mr('feat/cart', 'main'), DEFAULT_RELEASE_BRANCHES)).toBe(false)
    expect(isReleaseMergeRequest(mr('feat/cart', 'develop'), DEFAULT_RELEASE_BRANCHES)).toBe(false)
    expect(isReleaseMergeRequest(mr('develop', 'main'), [])).toBe(false)
    expect(isReleaseMergeRequest(mr('develop', 'main'), ['develop', ':main'])).toBe(false)
  })
})

describe('skipReason', () => {
  test('release merge requests and our own ones are skipped', () => {
    expect(skipReason(mr('develop', 'main'), defaults)).toBe('release merge request develop → main')
    expect(skipReason(mr('feat/a', 'main', 'Holtkeeper'), defaults, 'holtkeeper')).toBe(
      'merge request by Holtkeeper (Holtkeeper)',
    )
    expect(skipReason(mr('feat/a', 'main', 'holtkeeper'), defaults)).toBeUndefined()
    expect(
      skipReason(
        mr('feat/a', 'main', 'holtkeeper'),
        { ...defaults, reviewOwn: true },
        'holtkeeper',
      ),
    ).toBeUndefined()
    expect(skipReason(mr('feat/a', 'main'), defaults, 'holtkeeper')).toBeUndefined()
  })
})
