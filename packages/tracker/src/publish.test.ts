import { describe, expect, test } from 'bun:test'

import {
  fakeDocuments,
  fakeForge,
  fakeSink,
  featureFlags,
  flagsPage,
  forgeFiles,
  gameRepos,
} from '../test/fixtures.ts'
import { type DocumentSink, isVersionConflict } from './contracts.ts'
import { runTracker } from './engine.ts'
import { publishTracker } from './publish.ts'
import type { Publication } from './types.ts'

const plan = () =>
  runTracker(featureFlags, {
    forge: fakeForge(forgeFiles),
    forgeId: 'work',
    repos: gameRepos,
    documents: { confluence: fakeDocuments([flagsPage]) },
    now: new Date('2026-10-30T12:00:00Z'),
  })

describe('publishTracker', () => {
  test('writes planned sections with the version read, and reports unchanged ones', async () => {
    const data = await plan()
    const sink = fakeSink(7)
    const first = await publishTracker(data, { sinks: { confluence: sink } })
    expect(first).toMatchObject({ published: 1, conflicts: 0, failed: 0 })
    expect(first.outcomes).toEqual([
      {
        output: 'wiki-section',
        provider: 'confluence',
        ref: '12345',
        markerId: 'holtkeeper:flags',
        status: 'published',
        version: 8,
        url: 'https://wiki.example.com/pages/12345',
      },
    ])
    expect(sink.writes[0]?.input).toMatchObject({
      markerId: 'holtkeeper:flags',
      format: 'storage',
      expectedVersion: 7,
      message: 'Update Feature flags',
    })

    const again = await publishTracker(
      {
        publications: data.publications.map((publication) => ({
          ...publication,
          expectedVersion: 8,
        })),
      },
      { sinks: { confluence: sink } },
    )
    expect(again.outcomes[0]?.status).toBe('unchanged')
    expect(sink.writes).toHaveLength(1)
  })

  test('reports a version conflict instead of overwriting', async () => {
    const data = await plan()
    const sink = fakeSink(9)
    const result = await publishTracker(data, { sinks: { confluence: sink } })
    expect(result.conflicts).toBe(1)
    expect(result.outcomes[0]?.status).toBe('conflict')
    expect(result.outcomes[0]?.message).toContain('version 7')
    expect(sink.writes).toEqual([])
  })

  test('skips missing sinks, isolates failures and filters outputs', async () => {
    const publications: Publication[] = [
      {
        output: 'a',
        kind: 'document-section',
        provider: 'wiki',
        ref: '1',
        markerId: 'm',
        format: 'html',
        content: 'x',
      },
      {
        output: 'b',
        kind: 'document-section',
        provider: 'confluence',
        ref: '2',
        markerId: '',
        format: 'storage',
        content: 'y',
      },
      {
        output: 'c',
        kind: 'document-section',
        provider: 'confluence',
        ref: '3',
        markerId: 'm',
        format: 'storage',
        content: 'z',
      },
      { output: 'n', kind: 'notify', format: 'text', content: 'hello' },
    ]
    const failing: DocumentSink = {
      provider: 'confluence',
      async replaceSection(ref) {
        if (ref === '2') throw Object.assign(new Error('HTTP 409'), { status: 409 })
        throw new Error('boom')
      },
    }
    const result = await publishTracker({ publications }, { sinks: { confluence: failing } })
    expect(result.outcomes.map((outcome) => [outcome.output, outcome.status])).toEqual([
      ['a', 'skipped'],
      ['b', 'conflict'],
      ['c', 'failed'],
    ])
    expect(result.outcomes[2]?.message).toBe('boom')
    const only = await publishTracker(
      { publications },
      { sinks: { confluence: fakeSink() }, outputs: ['c'] },
    )
    expect(only.outcomes.map((outcome) => outcome.output)).toEqual(['c'])
  })
})

test('isVersionConflict', () => {
  expect(isVersionConflict({ code: 'conflict' })).toBe(true)
  expect(
    isVersionConflict(Object.assign(new Error('x'), { name: 'DocumentVersionConflictError' })),
  ).toBe(true)
  expect(isVersionConflict(new Error('x'))).toBe(false)
  expect(isVersionConflict('409')).toBe(false)
})
