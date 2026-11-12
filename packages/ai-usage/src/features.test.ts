import { describe, expect, test } from 'bun:test'

import { featureOf, featureTaskKinds, filterableFeatures } from './features.ts'

describe('featureOf', () => {
  test('maps task kinds to features and the rest to other', () => {
    expect(featureOf('review')).toBe('reviews')
    expect(featureOf('triage')).toBe('reviews')
    expect(featureOf('write-task')).toBe('tasks')
    expect(featureOf('chat-summary')).toBe('chat')
    expect(featureOf('learning')).toBe('knowledge')
    expect(featureOf('release-notes')).toBe('releases')
    expect(featureOf('widget-digest')).toBe('other')
    expect(featureOf('')).toBe('other')
  })

  test('every listed kind maps back to its feature, and no kind is listed twice', () => {
    const kinds = filterableFeatures.flatMap((feature) => featureTaskKinds[feature])
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const feature of filterableFeatures)
      for (const kind of featureTaskKinds[feature]) expect(featureOf(kind)).toBe(feature)
  })
})
