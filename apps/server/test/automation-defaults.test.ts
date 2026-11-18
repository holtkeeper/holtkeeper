import { expect, test } from 'bun:test'

import { builtinAnalyzers } from '@holtkeeper/analyzers'
import { defaultTriggers } from '@holtkeeper/managed-config'

import { newRepoAnalyzers } from '../src/new-repos.ts'

test('default triggers only name analyzers the server ships', () => {
  const kinds = new Set(builtinAnalyzers.map((analyzer) => analyzer.kind))
  const named = defaultTriggers.flatMap((trigger) =>
    'analyzers' in trigger.data ? (trigger.data.analyzers ?? []) : [],
  )
  expect(named.filter((kind) => !kinds.has(kind))).toEqual([])
  const newRepo = defaultTriggers.find((trigger) => trigger.id === 'new-repo')?.data
  expect(newRepo?.on).toBe('newRepo')
  if (newRepo?.on === 'newRepo')
    expect(newRepoAnalyzers(newRepo, builtinAnalyzers)).toEqual(
      expect.arrayContaining(['rule-miner']),
    )
})

test('every shipped analyzer declares freshness except review, i18n, audit and licenses (the vulnerability and license indexes) and those that write to repositories', () => {
  const manual = builtinAnalyzers.filter((analyzer) => !analyzer.refresh).map((a) => a.kind)
  expect(manual.toSorted()).toEqual([
    'audit',
    'browserslist',
    'i18n',
    'licenses',
    'propagate',
    'review',
    'write-task',
  ])
  for (const analyzer of builtinAnalyzers) {
    if (analyzer.scope === 'group' && analyzer.refresh) expect(analyzer.refresh.on).toBe('time')
    if (analyzer.needs.agent && analyzer.refresh?.on === 'change')
      expect(['1d', '7d', '14d']).toContain(analyzer.refresh.minInterval)
  }
})
