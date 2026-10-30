import { describe, expect, test } from 'bun:test'

import {
  fakeDocuments,
  fakeForge,
  featureFlags,
  flagsPage,
  forgeFiles,
  gameRepos,
} from '../test/fixtures.ts'
import { runTracker } from './engine.ts'
import { trackerAnalysis } from './report.ts'
import type { TrackerData } from './types.ts'

const repo = { forge: 'work', path: 'games' }

async function data(files = forgeFiles): Promise<TrackerData> {
  return runTracker(featureFlags, {
    forge: fakeForge(files),
    forgeId: 'work',
    repos: gameRepos,
    documents: { confluence: fakeDocuments([flagsPage]) },
    now: new Date('2026-10-30T12:00:00Z'),
  })
}

const record = (id: string, value: TrackerData, createdAt = '2026-10-30T12:00:00.000Z') => ({
  id,
  repo,
  kind: 'tracker',
  createdAt,
  data: value,
})

describe('trackerAnalysis', () => {
  test('validates its data and lists changes', async () => {
    const current = await data()
    expect(trackerAnalysis.schema.parse(current)).toEqual(current)
    expect(trackerAnalysis.changes?.(current)).toEqual(current.changes)
  })

  test('report sections, metrics and deltas against the previous run', async () => {
    const current = await data()
    const helm = {
      ...forgeFiles['infra/helm'],
      'charts/slots/values-prod.yaml': 'featureFlags:\n  new_lobby: false\n  turbo_spin: true\n',
    }
    const before = await data({
      ...forgeFiles,
      'infra/helm': helm,
      'games/poker': { ...forgeFiles['games/poker'], 'src/table.tsx': "isEnabled('new_lobby')\n" },
    })
    const report = trackerAnalysis.toReport(
      record('a2', current),
      record('a1', before, '2026-10-01T00:00:00.000Z'),
    )
    expect(report.title).toBe('Feature flags')
    expect(report.subject?.compareTo).toBe('2026-10-01')
    expect(report.sections.map((section) => section.id)).toEqual([
      'entities',
      'findings',
      'matrix',
      'publications',
      'changes',
    ])
    const metric = (id: string) => report.metrics.find((entry) => entry.id === id)
    expect(metric('entities')).toMatchObject({ value: 6, delta: 2 })
    expect(metric('findings')).toMatchObject({ value: 7, tone: 'bad' })
    expect(metric('rule:undefined')).toMatchObject({ value: 1, delta: 1 })

    const entities = report.sections[0]!
    const table = entities.blocks[0]
    expect(
      table?.type === 'table' &&
        table.rows.find((row) => row.key && typeof row.key === 'object')?.key,
    ).toMatchObject({ text: 'ghost_flag', tone: 'info' })

    const findings = report.sections[1]!
    const titles = findings.blocks.map((block) => (block.type === 'issues' ? block.title : ''))
    expect(titles).toContain('undefined (1)')
    const undefinedBlock = findings.blocks.find(
      (block) => block.type === 'issues' && block.title === 'undefined (1)',
    )
    expect(undefinedBlock?.type === 'issues' && undefinedBlock.items[0]?.tags).toEqual([
      'error',
      'new',
    ])

    const matrix = report.sections[2]!.blocks[0]
    expect(matrix?.type === 'table' && matrix.columns.map((column) => column.label)).toEqual([
      'Feature flag',
      'games/poker',
      'games/slots',
      'env: dev',
      'env: prod',
    ])
    expect(
      matrix?.type === 'table' && matrix.rows.find((row) => row.key === 'new_lobby'),
    ).toMatchObject({ 'repo:games/poker': 'def usage', 'env:prod': 'false' })

    const publications = report.sections[3]!.blocks.map((block) =>
      block.type === 'markdown' ? block.text : '',
    )
    expect(publications[0]).toStartWith(
      '**wiki-section** → confluence `12345`, between markers `holtkeeper:flags` (expects version 7)\n\n```html\n<h2>Flag inventory</h2>',
    )
    expect(publications.at(-1)).toContain('POST /api/trackers/a2/publish')
    const changes = report.sections[4]!.blocks[0]
    expect(changes?.type === 'changes' && changes.applicable).toBe(true)
  })

  test('resolved findings and errors; previous runs of other trackers are ignored', async () => {
    const current = await data()
    const fixed: TrackerData = {
      ...current,
      findings: current.findings.slice(1),
      errors: [{ source: 'helm', repo: 'infra/helm', file: 'x.yaml', message: 'bad' }],
    }
    const report = trackerAnalysis.toReport(record('b', fixed), record('a', current))
    const resolved = report.sections[1]!.blocks.find(
      (block) => block.type === 'issues' && block.title === 'Resolved (1)',
    )
    expect(resolved?.type === 'issues' && resolved.items[0]?.tone).toBe('good')
    const errors = report.sections.find((section) => section.id === 'errors')?.blocks[0]
    expect(errors?.type === 'issues' && errors.items[0]?.title).toBe('infra/helm/x.yaml: bad')

    const other = trackerAnalysis.toReport(
      record('c', current),
      record('d', { ...current, tracker: { ...current.tracker, id: 'other' } }),
    )
    expect(other.subject?.compareTo).toBeUndefined()
    expect(other.metrics.find((entry) => entry.id === 'entities')?.delta).toBeUndefined()
  })
})
