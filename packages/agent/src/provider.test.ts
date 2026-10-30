import { describe, expect, test } from 'bun:test'

import {
  costFromPricing,
  isAiProviderKind,
  mapModel,
  parseProviderOptions,
  providerOptionsIssues,
  renderHeaders,
} from './provider.ts'

describe('provider options', () => {
  test('parse per kind with defaults', () => {
    expect(parseProviderOptions({ kind: 'anthropic' })).toEqual({ kind: 'anthropic' })
    expect(
      parseProviderOptions({
        kind: 'anthropic-compatible',
        options: { headers: { 'X-Key': '{secret}' }, modelMap: { a: 'b' } },
      }),
    ).toEqual({
      kind: 'anthropic-compatible',
      authHeader: 'x-api-key',
      headers: { 'X-Key': '{secret}' },
      modelMap: { a: 'b' },
    })
    expect(
      parseProviderOptions({ kind: 'bedrock', options: { region: 'eu-west-1' } }),
    ).toMatchObject({ credentials: 'env' })
    expect(parseProviderOptions({ kind: 'openai-compatible' })).toEqual({
      kind: 'openai-compatible',
      supportsTools: true,
    })
  })

  test('report every problem with its field', () => {
    expect(providerOptionsIssues('gitlab', {})).toEqual(['kind: gitlab is not an AI provider kind'])
    expect(providerOptionsIssues('vertex', { region: 'x' })).toEqual([
      'options.projectId: Invalid input: expected string, received undefined',
    ])
    expect(providerOptionsIssues('openai-compatible', { supportsTools: false })).toEqual([
      'options.supportsTools: the provider must support tool calling',
    ])
    expect(
      providerOptionsIssues('anthropic-compatible', {
        baseUrl: 'ftp://x',
        headers: { 'Bad Name': 'v', ok: 'a\nb' },
        pricing: { m: { inputPerMTok: -1, outputPerMTok: 1 } },
      }),
    ).toHaveLength(4)
    expect(() => parseProviderOptions({ kind: 'bedrock', options: {} })).toThrow(
      'invalid AI provider: options.region',
    )
    expect(isAiProviderKind('vertex')).toBe(true)
    expect(isAiProviderKind('github')).toBe(false)
  })

  test('helpers map models, render headers and price usage', () => {
    expect(mapModel('a', { a: 'b' })).toBe('b')
    expect(mapModel('c', { a: 'b' })).toBe('c')
    expect(renderHeaders({ 'X-Key': 'k={secret}', Other: 'x' }, 's3')).toEqual({
      'X-Key': 'k=s3',
      Other: 'x',
    })
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    }
    expect(
      costFromPricing(usage, { m: { inputPerMTok: 2, outputPerMTok: 10 } }, undefined, 'm'),
    ).toBe(2 + 5 + 2)
    expect(
      costFromPricing(
        usage,
        { m: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 } },
        'm',
      ),
    ).toBeCloseTo(7.2)
    expect(
      costFromPricing(usage, { m: { inputPerMTok: 2, outputPerMTok: 10 } }, 'x'),
    ).toBeUndefined()
  })
})

describe('aiProviderOptionsValidator', () => {
  test('checks AI kinds and ignores others', async () => {
    const { aiProviderOptionsValidator } = await import('./provider.ts')
    expect(aiProviderOptionsValidator('gitlab', { x: 1 })).toBeUndefined()
    expect(aiProviderOptionsValidator('bedrock', { region: 'eu' })).toEqual([])
    expect(aiProviderOptionsValidator('bedrock', undefined)?.[0]).toStartWith('options.region')
  })
})
