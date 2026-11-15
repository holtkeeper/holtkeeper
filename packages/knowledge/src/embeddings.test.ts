import { describe, expect, test } from 'bun:test'

import { contentHash } from '@holtkeeper/embed'

import { embeddingSubject, embeddingText, fusedRelevance } from './embeddings.ts'

describe('embeddingText', () => {
  test('is the title, a blank line, the body and a topics line', () => {
    expect(
      embeddingText({
        title: ' Round widget corners ',
        body: 'Use the radius token.\n',
        topics: ['widgets', 'styles'],
      }),
    ).toBe('Round widget corners\n\nUse the radius token.\nTopics: widgets, styles')
    expect(embeddingText({ title: 'Shapes', body: 'Circles first.', topics: [] })).toBe(
      'Shapes\n\nCircles first.',
    )
  })

  test('its hash changes with the title, body or topics only', () => {
    const base = { title: 'Shapes', body: 'Circles first.', topics: ['geometry'] }
    const hash = (entry: typeof base) => contentHash(embeddingText(entry))
    expect(hash({ ...base })).toBe(hash(base))
    expect(hash({ ...base, title: 'Shape' })).not.toBe(hash(base))
    expect(hash({ ...base, body: 'Squares first.' })).not.toBe(hash(base))
    expect(hash({ ...base, topics: ['geometry', 'math'] })).not.toBe(hash(base))
  })
})

test('embeddingSubject prefixes the entry id', () => {
  expect(embeddingSubject('k1')).toBe('knowledge:k1')
})

describe('fusedRelevance', () => {
  test('fuses the lexical and the vector ranking; missing items get nothing from a ranking', () => {
    const fused = fusedRelevance(
      [
        { id: 'a', lexical: 3 },
        { id: 'b', lexical: 1 },
        { id: 'c', lexical: 0 },
        { id: 'd', lexical: 0 },
      ],
      new Map([
        ['b', 0.9],
        ['c', 0.8],
        ['a', 0.1],
        ['elsewhere', 1],
      ]),
    )
    expect(fused.get('a')).toBeCloseTo(1 / 61 + 1 / 63, 12)
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(fused.get('c')).toBeCloseTo(1 / 62, 12)
    expect(fused.get('d')).toBe(0)
    expect(fused.has('elsewhere')).toBeFalse()
  })

  test('lexical ties keep the order given', () => {
    const fused = fusedRelevance(
      [
        { id: 'newer', lexical: 1 },
        { id: 'older', lexical: 1 },
      ],
      new Map(),
    )
    expect(fused.get('newer')).toBeGreaterThan(fused.get('older')!)
  })
})
