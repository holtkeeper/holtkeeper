import { expect, test } from 'bun:test'

import type { AnalyzerContext } from '@holtkeeper/analyzer'
import type { GitForge } from '@holtkeeper/forge'

import {
  fakeDocuments,
  fakeForge,
  featureFlags,
  flagsPage,
  forgeFiles,
  gameRepos,
} from '../test/fixtures.ts'
import { createTrackerAnalyzer, trackerOptionsSchema } from './analyzer.ts'

const runner = {} as AnalyzerContext<unknown>['runner']
const forge = fakeForge(forgeFiles) as unknown as GitForge

test('runs a tracker by id with injected documents and sinks', async () => {
  const analyzer = createTrackerAnalyzer({
    definitionsFor: () => [featureFlags],
    documentsFor: () => ({ confluence: fakeDocuments([flagsPage]) }),
    sinksFor: () => ({}),
    now: () => new Date('2026-10-30T12:00:00Z'),
  })
  expect(analyzer).toMatchObject({ kind: 'tracker', scope: 'group', needs: { forge: true } })
  const { data } = await analyzer.run({
    repo: { forge: 'work', path: 'games' },
    repos: gameRepos,
    forge,
    runner,
    options: trackerOptionsSchema.parse({ tracker: 'feature-flags' }),
  })
  expect(data.tracker.id).toBe('feature-flags')
  expect(data.entities).toHaveLength(6)
  expect(data.changes[0]?.target).toEqual({ forge: 'work', path: 'infra/helm' })
  expect(data.errors.map((error) => error.message)).toEqual([
    'no document sink for provider confluence; the section cannot be published',
  ])
})

test('accepts inline definitions and rejects unknown ids', async () => {
  const analyzer = createTrackerAnalyzer({ definitionsFor: () => [featureFlags] })
  const inline = trackerOptionsSchema.parse({
    definition: {
      id: 'env',
      name: 'Env',
      sources: [
        {
          kind: 'files',
          role: 'definition',
          repos: ['games/slots'],
          paths: ['src/flags.json'],
          extract: { kind: 'json-path', path: '$.flags[*].name' },
        },
      ],
    },
  })
  const { data } = await analyzer.run({
    repo: { forge: 'work', path: 'games' },
    repos: gameRepos,
    forge,
    runner,
    options: inline,
  })
  expect(data.entities.map((entity) => entity.key)).toEqual(['new_lobby', 'turbo_spin'])
  expect(
    analyzer.run({
      repo: { forge: 'work', path: 'games' },
      forge,
      runner,
      options: { tracker: 'nope' },
    }),
  ).rejects.toThrow('tracker nope is not defined; known: feature-flags')
  expect(trackerOptionsSchema.safeParse({}).success).toBe(false)
})
