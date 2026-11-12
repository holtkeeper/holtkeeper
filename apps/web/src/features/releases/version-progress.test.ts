import { describe, expect, test } from 'bun:test'

import { deployProgress } from './version-progress.ts'

describe('deployProgress', () => {
  test('is undefined without environments', () => {
    expect(deployProgress([])).toBeUndefined()
  })

  test('counts successful deploys and keeps missing ones neutral', () => {
    const progress = deployProgress([
      { tone: 'success', label: 'staging: deployed' },
      { tone: 'skipped', label: 'production: not deployed' },
    ])
    expect(progress?.label).toBe('Deployed to 1 of 2 environments')
    expect(progress?.segments.map((segment) => segment.tone)).toEqual(['success', 'default'])
  })

  test('uses the singular for one environment', () => {
    expect(deployProgress([{ tone: 'danger', label: 'production: failed' }])?.label).toBe(
      'Deployed to 0 of 1 environment',
    )
  })
})
