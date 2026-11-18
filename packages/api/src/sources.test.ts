import { describe, expect, test } from 'bun:test'

import { sourceInfo } from './sources.ts'

describe('sourceInfo', () => {
  test('recognizes lockfiles in nested paths', () => {
    expect(sourceInfo('apps/web/pnpm-lock.yaml')).toEqual({
      tool: 'pnpm',
      label: 'pnpm',
      language: 'JavaScript',
    })
    expect(sourceInfo('go.mod').language).toBe('Go')
    expect(sourceInfo('weird.lock')).toEqual({
      tool: 'other',
      label: 'weird.lock',
      language: 'Other',
    })
  })
})
