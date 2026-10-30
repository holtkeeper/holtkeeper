import { describe, expect, test } from 'bun:test'

import { applyPreset, matchingPreset } from './presets.ts'

const strict = { id: 'strict', label: 'Strict', value: { unknown: 'violation', allow: ['MIT'] } }
const models = { id: 'cheap', label: 'Cheap', value: ['quirk'] }

describe('presets', () => {
  test('apply over objects keeps other fields', () => {
    expect(applyPreset({ ignore: ['x'], allow: ['ISC'] }, strict)).toEqual({
      ignore: ['x'],
      allow: ['MIT'],
      unknown: 'violation',
    })
  })

  test('apply replaces other values with a copy', () => {
    const applied = applyPreset(['howto'], models)
    expect(applied).toEqual(['quirk'])
    expect(applied).not.toBe(models.value)
    expect(applyPreset(undefined, strict)).toEqual(strict.value)
  })

  test('match by the preset fields', () => {
    expect(matchingPreset({ ...strict.value, ignore: [] }, [models, strict])?.id).toBe('strict')
    expect(matchingPreset({ unknown: 'warn' }, [strict])).toBeUndefined()
    expect(matchingPreset(['quirk'], [models])?.id).toBe('cheap')
  })
})
