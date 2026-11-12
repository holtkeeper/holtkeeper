import { expect, test } from 'bun:test'

import { z } from 'zod'

import { unknownSettingKeys } from './unknown-keys.ts'

const schema = z.object({
  size: z.number().default(1),
  limits: z.object({ max: z.number() }).optional(),
})

test('lists keys a stripping object schema drops, nested ones included', () => {
  expect(
    unknownSettingKeys({ schema }, { size: 2, color: 'red', limits: { max: 3, min: 1 } }),
  ).toEqual([{ key: 'color' }, { key: 'limits.min' }])
  expect(unknownSettingKeys({ schema }, { size: 2 })).toEqual([])
})

test('names where a moved key lives now', () => {
  expect(
    unknownSettingKeys({ schema, movedKeys: { color: 'widget.style › color' } }, { color: 'red' }),
  ).toEqual([{ key: 'color', movedTo: 'widget.style › color' }])
})

test('reads the form when the schema cannot describe the shape', () => {
  const definition = {
    schema: z.record(z.string(), z.unknown()),
    form: z.object({ depth: z.number().optional() }).meta({ title: 'Options' }),
  }
  expect(unknownSettingKeys(definition, { depth: 1, legacy: true })).toEqual([{ key: 'legacy' }])
})

test('ignores secret settings, non-object values and schemas that keep or refuse extra keys', () => {
  expect(unknownSettingKeys({ schema, secret: true }, { color: 'red' })).toEqual([])
  expect(unknownSettingKeys({ schema: z.array(z.string()) }, ['a'])).toEqual([])
  expect(unknownSettingKeys({ schema }, null)).toEqual([])
  expect(unknownSettingKeys({ schema: schema.loose() }, { color: 'red' })).toEqual([])
  expect(unknownSettingKeys({ schema: schema.strict() }, { color: 'red' })).toEqual([])
})
