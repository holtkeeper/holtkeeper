import { expect, test } from 'bun:test'

import { forgeErrorStatus } from './errors.ts'

test('forgeErrorStatus reads a numeric status only', () => {
  expect(forgeErrorStatus(Object.assign(new Error('404 Project Not Found'), { status: 404 }))).toBe(
    404,
  )
  expect(forgeErrorStatus(new Error('socket hang up'))).toBeUndefined()
  expect(forgeErrorStatus({ status: '404' })).toBeUndefined()
  expect(forgeErrorStatus(undefined)).toBeUndefined()
})
