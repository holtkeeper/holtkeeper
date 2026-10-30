import { describe, expect, test } from 'bun:test'

import { defaultValue, editorFor, parseJson, previewValue } from './schema.ts'

describe('editorFor', () => {
  test('maps schema shapes to editors', () => {
    expect(editorFor({ type: 'string' }, true)).toEqual({ kind: 'secret' })
    expect(editorFor({ type: 'boolean' }, false)).toEqual({ kind: 'boolean' })
    expect(editorFor({ type: 'string', enum: ['a', 'b'] }, false)).toEqual({
      kind: 'enum',
      options: ['a', 'b'],
    })
    expect(editorFor({ anyOf: [{ const: 'x' }, { const: 'y' }] }, false)).toEqual({
      kind: 'enum',
      options: ['x', 'y'],
    })
    expect(editorFor({ type: 'integer' }, false)).toEqual({ kind: 'number', integer: true })
    expect(editorFor({ type: 'string' }, false)).toEqual({ kind: 'string' })
    expect(editorFor({ type: 'array', items: {} }, false)).toEqual({ kind: 'json' })
    expect(editorFor(undefined, false)).toEqual({ kind: 'json' })
  })
})

describe('values', () => {
  test('defaults', () => {
    expect(defaultValue({ type: 'array' })).toEqual([])
    expect(defaultValue({ type: 'boolean' })).toBe(false)
    expect(defaultValue({ type: 'string', default: 'x' })).toBe('x')
    expect(defaultValue({ enum: ['a'] })).toBe('a')
    expect(defaultValue(null)).toBeNull()
  })

  test('json parsing', () => {
    expect(parseJson('[1]')).toEqual({ ok: true, value: [1] })
    expect(parseJson('[').ok).toBe(false)
  })

  test('previews', () => {
    expect(previewValue(null, true)).toBe('set')
    expect(previewValue([1, 2], false)).toBe('2 items')
    expect(previewValue(true, false)).toBe('true')
    expect(previewValue('', false)).toBe('""')
  })
})
