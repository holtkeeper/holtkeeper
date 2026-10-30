import { expect, test } from 'bun:test'

import { blockTypes } from '../../lib/analyses.ts'
import { renderers } from './registry.tsx'

test('every block type of the report model has a renderer', () => {
  expect(Object.keys(renderers).toSorted()).toEqual([...blockTypes].toSorted())
  for (const type of blockTypes) expect(typeof renderers[type]).toBe('function')
})
