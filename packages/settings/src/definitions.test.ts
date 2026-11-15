import { describe, expect, test } from 'bun:test'

import { DEFAULT_EMBEDDING_MODEL, builtinSettings, knowledgeEmbeddings } from './definitions.ts'

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

describe('knowledgeEmbeddings', () => {
  test('is off with the default model until someone turns it on', () => {
    expect(knowledgeEmbeddings.global).toBe(true)
    expect(knowledgeEmbeddings.schema.parse({})).toEqual({
      enabled: false,
      model: DEFAULT_EMBEDDING_MODEL,
    })
  })

  test('keeps the credential and dimensions people set', () => {
    expect(
      knowledgeEmbeddings.schema.parse({
        enabled: true,
        credential: ' gateway ',
        model: 'acme/embed-small',
        dimensions: 512,
      }),
    ).toEqual({ enabled: true, credential: 'gateway', model: 'acme/embed-small', dimensions: 512 })
  })

  test('refuses an empty model and odd dimensions', () => {
    expect(knowledgeEmbeddings.schema.safeParse({ model: ' ' }).success).toBe(false)
    expect(knowledgeEmbeddings.schema.safeParse({ dimensions: 0 }).success).toBe(false)
    expect(knowledgeEmbeddings.schema.safeParse({ dimensions: 1.5 }).success).toBe(false)
  })
})
