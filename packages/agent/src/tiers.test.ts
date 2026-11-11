import { describe, expect, test } from 'bun:test'

import { FALLBACK_TIER_MODELS, resolveTierModels } from './tiers.ts'

const listing = (...ids: string[]) => ({
  models: ids.map((id) => ({ id, source: 'provider' as const })),
})

describe('resolveTierModels', () => {
  test('picks the newest Haiku, Sonnet and Opus the provider lists', () => {
    expect(
      resolveTierModels(
        listing(
          'claude-haiku-4-5',
          'claude-haiku-5-5',
          'claude-sonnet-5',
          'claude-sonnet-5-5',
          'claude-opus-5',
          'claude-opus-5-5',
          'claude-opus-5-5-mini',
        ),
      ),
    ).toEqual({ fast: 'claude-haiku-5-5', main: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' })
  })

  test('matches vendor-prefixed and dotted ids of routers', () => {
    expect(
      resolveTierModels(
        listing('vendor/claude-haiku-5.5', 'vendor/claude-sonnet-5.5', 'vendor/claude-opus-5.5'),
      ),
    ).toEqual({
      fast: 'vendor/claude-haiku-5.5',
      main: 'vendor/claude-sonnet-5.5',
      deep: 'vendor/claude-opus-5.5',
    })
  })

  test('falls back when the provider cannot list its models', () => {
    expect(resolveTierModels({ models: [], error: 'HTTP 500' })).toEqual(FALLBACK_TIER_MODELS)
    expect(resolveTierModels({ models: [] })).toEqual(FALLBACK_TIER_MODELS)
    expect(
      resolveTierModels({ models: [{ id: 'claude-opus-6', source: 'config' }], error: 'HTTP 401' }),
    ).toEqual({ ...FALLBACK_TIER_MODELS, deep: 'claude-opus-6' })
  })

  test('a tier without its family runs on the nearest listed tier', () => {
    const logs: string[] = []
    expect(
      resolveTierModels(listing('gpt-5', 'claude-opus-5-5'), { log: (line) => logs.push(line) }),
    ).toEqual({ fast: 'claude-opus-5-5', main: 'claude-opus-5-5', deep: 'claude-opus-5-5' })
    expect(logs).toEqual([
      'the provider lists no claude-haiku model, tier fast runs on deep (claude-opus-5-5)',
      'the provider lists no claude-sonnet model, tier main runs on deep (claude-opus-5-5)',
    ])
    expect(resolveTierModels(listing('claude-haiku-5-5', 'claude-sonnet-5-5'))).toEqual({
      fast: 'claude-haiku-5-5',
      main: 'claude-sonnet-5-5',
      deep: 'claude-sonnet-5-5',
    })
    expect(resolveTierModels(listing('claude-haiku-5-5', 'claude-opus-5-5'))).toEqual({
      fast: 'claude-haiku-5-5',
      main: 'claude-opus-5-5',
      deep: 'claude-opus-5-5',
    })
    expect(resolveTierModels(listing('claude-haiku-5-5')).deep).toBe('claude-haiku-5-5')
  })

  test('throws when the provider lists no Claude family at all', () => {
    expect(() => resolveTierModels(listing('gpt-5', 'other-model-2'))).toThrow(
      'the provider lists no Claude model',
    )
  })
})
