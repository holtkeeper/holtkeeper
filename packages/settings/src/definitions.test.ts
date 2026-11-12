import { describe, expect, test } from 'bun:test'

import { builtinSettings } from './definitions.ts'

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
