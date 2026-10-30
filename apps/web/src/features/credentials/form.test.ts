import { describe, expect, test } from 'bun:test'

import {
  OPENAI_COMPATIBLE,
  agentModels,
  filterProviders,
  toCreateInput,
  toDraft,
  toUpdateInput,
  validateDraft,
} from './form.ts'

describe('credential form', () => {
  test('a new draft needs name and secret', () => {
    const draft = toDraft()
    expect(validateDraft(draft, true)).toEqual({
      name: 'Name is required',
      secret: 'Secret is required',
    })
    expect(validateDraft({ ...draft, name: 'x' }, false)).toEqual({})
  })

  test('validates url, scope and rotation days', () => {
    const draft = {
      ...toDraft(),
      name: 'x',
      secret: 's',
      url: 'nope',
      scope: { groups: [] },
      rotation: true,
      daysBefore: '90',
      lifetimeDays: '30',
    }
    expect(Object.keys(validateDraft(draft, true)).toSorted()).toEqual([
      'daysBefore',
      'scope',
      'url',
    ])
  })

  test('builds inputs', () => {
    const draft = {
      ...toDraft(),
      name: ' GitLab ',
      secret: 'glpat',
      expires: '2027-01-31',
      scope: { groups: ['g', 'g'] },
    }
    expect(toCreateInput(draft)).toEqual({
      name: 'GitLab',
      kind: 'gitlab',
      url: 'https://gitlab.com',
      scope: { groups: ['g'] },
      secret: 'glpat',
      expiresAt: '2027-01-31T00:00:00.000Z',
      rotation: { enabled: false, daysBefore: 14, lifetimeDays: 90 },
    })
    expect('secret' in toUpdateInput({ ...draft, secret: '' })).toBe(false)
  })
})

describe('AI provider credentials', () => {
  const stored = {
    id: 'c1',
    name: 'OpenRouter',
    kind: 'ai-sdk',
    url: 'https://openrouter.ai/api/v1',
    scope: { all: true },
    options: {
      provider: 'openrouter',
      package: '@openrouter/ai-sdk-provider',
      model: 'openai/gpt-5',
      maxConcurrency: 4,
      headers: { 'X-Team': 'games' },
    },
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  }

  test('round-trips options, keeping the rest as advanced JSON', () => {
    const draft = toDraft(stored)
    expect(draft.ai).toMatchObject({
      provider: 'openrouter',
      package: '@openrouter/ai-sdk-provider',
      model: 'openai/gpt-5',
      baseUrl: '',
      custom: false,
    })
    expect(JSON.parse(draft.ai.advanced)).toEqual({
      maxConcurrency: 4,
      headers: { 'X-Team': 'games' },
    })
    expect(validateDraft(draft, false)).toEqual({})
    expect(toUpdateInput(draft)).toMatchObject({
      url: 'https://openrouter.ai/api/v1',
      options: stored.options,
    })
  })

  test('needs a provider, a base URL for your own OpenAI-compatible one and valid JSON', () => {
    const draft = { ...toDraft(), name: 'x', secret: 's', kind: 'ai-sdk' }
    expect(validateDraft(draft, true)).toEqual({ provider: 'Choose a provider' })
    const custom = {
      ...draft,
      ai: { ...draft.ai, custom: true, provider: 'corp', advanced: '[1]' },
    }
    expect(validateDraft(custom, true)).toEqual({
      baseUrl: 'An OpenAI-compatible provider needs its base URL',
      advanced: 'Advanced options must be a JSON object',
    })
    const ready = {
      ...custom,
      ai: { ...custom.ai, baseUrl: 'https://llm.corp.test/v1', advanced: '', model: 'big' },
    }
    expect(validateDraft(ready, true)).toEqual({})
    expect(toCreateInput(ready)).toMatchObject({
      kind: 'ai-sdk',
      url: 'https://llm.corp.test/v1',
      options: {
        provider: 'corp',
        package: OPENAI_COMPATIBLE,
        baseUrl: 'https://llm.corp.test/v1',
        model: 'big',
      },
    })
  })

  test('provider search and agent models', () => {
    const providers = [
      { id: 'groq', name: 'Groq' },
      { id: 'openrouter', name: 'OpenRouter' },
      { id: 'nano-gpt', name: 'NanoGPT Router' },
    ]
    expect(filterProviders(providers, 'rout').map((p) => p.id)).toEqual(['openrouter', 'nano-gpt'])
    expect(filterProviders(providers, ' ')).toHaveLength(3)
    expect(
      agentModels([
        { id: 'a', toolCall: true, createdAt: '2026-01-01' },
        { id: 'b', toolCall: false, createdAt: '2026-09-01' },
        { id: 'c', createdAt: '2026-06-01' },
      ]).map((m) => m.id),
    ).toEqual(['c', 'a'])
  })
})
