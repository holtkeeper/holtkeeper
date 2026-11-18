import { describe, expect, test } from 'bun:test'

import { builtinSettings, learningsApprovalDelayDays, learningsExpiryDays } from './definitions.ts'

describe('builtinSettings', () => {
  test.each(builtinSettings.map((definition) => [definition.key, definition] as const))(
    '%s has a default its schema accepts',
    (_, definition) => {
      expect('default' in definition).toBe(true)
      if (definition.default !== null)
        expect(definition.schema.safeParse(definition.default).success).toBe(true)
    },
  )
})

describe('learnings settings', () => {
  test('wait three days and expire after ninety by default', () => {
    expect(learningsApprovalDelayDays.default).toBe(3)
    expect(learningsExpiryDays.default).toBe(90)
    expect(learningsApprovalDelayDays.schema.safeParse(0).success).toBe(true)
    expect(learningsExpiryDays.schema.safeParse(0).success).toBe(false)
    expect(learningsApprovalDelayDays.schema.safeParse(1.5).success).toBe(false)
  })
})
