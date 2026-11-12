import { expect, test } from 'bun:test'

import { analyzerOptions, analyzersOffValue, readAnalyzersOff } from './analyzers-off.ts'

const schema = {
  type: 'object',
  properties: {
    off: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['audit', 'bundle'],
        'x-labels': { audit: 'Vulnerabilities', bundle: 'Bundle size' },
      },
      default: [],
    },
    reason: { type: 'string', minLength: 1 },
  },
}

test('options come from the off enum with their labels', () => {
  expect(analyzerOptions(schema)).toEqual([
    { id: 'audit', label: 'Vulnerabilities' },
    { id: 'bundle', label: 'Bundle size' },
  ])
  expect(analyzerOptions({ type: 'string' })).toEqual([])
})

test('reads stored values and drops what is not a kind', () => {
  expect(readAnalyzersOff({ off: ['audit', 3], reason: 'Values only' })).toEqual({
    off: ['audit'],
    reason: 'Values only',
  })
  expect(readAnalyzersOff(undefined)).toEqual({ off: [], reason: '' })
})

test('writes a reason only while something is off', () => {
  expect(analyzersOffValue(['audit'], 'Values only')).toEqual({
    off: ['audit'],
    reason: 'Values only',
  })
  expect(analyzersOffValue(['audit'], '  ')).toEqual({ off: ['audit'] })
  expect(analyzersOffValue([], 'Values only')).toEqual({ off: [] })
})
