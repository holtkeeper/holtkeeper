import { describe, expect, test } from 'bun:test'

import { taskGroupProgressLabel } from './progress.ts'

describe('taskGroupProgressLabel', () => {
  test('counts tasks that stopped working and shows spend against the cap', () => {
    expect(
      taskGroupProgressLabel(
        [{ status: 'mr-open' }, { status: 'running' }, { status: 'failed' }],
        1.2,
        10,
      ),
    ).toBe('2 of 3 repositories finished · $1.20 of $10.00')
  })

  test('leaves out an unknown cap', () => {
    expect(taskGroupProgressLabel([{ status: 'queued' }], 0.5)).toBe(
      '0 of 1 repository finished · $0.50',
    )
  })
})
