import { expect, test } from 'bun:test'

import type { JobAnalyzerView, SettingView } from '@holtkeeper/api'

import {
  analyzerArea,
  analyzerCounts,
  analyzerRows,
  filterAnalyzerRows,
  healthSummary,
} from './analyzer-catalog.ts'
import type { AutomationRule } from './automation-flow.ts'

const analyzer = (kind: string, patch: Partial<JobAnalyzerView> = {}): JobAnalyzerView => ({
  kind,
  label: kind,
  scope: 'repo',
  needs: {},
  schema: {},
  ...patch,
})

const rule = (patch: Partial<AutomationRule>): AutomationRule => ({
  id: 'rule',
  ref: { type: 'schedule', id: 'nightly' },
  title: 'Nightly',
  chips: [],
  enabled: true,
  ai: false,
  events: ['schedule'],
  analyzers: [],
  lanes: ['all'],
  actions: [],
  ...patch,
})

const setting = (key: string, scope: SettingView['scope'], value: unknown = {}): SettingView => ({
  id: `${key}-${JSON.stringify(scope)}`,
  key,
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

const analyzers = [
  analyzer('licenses', { refresh: { on: 'change', minInterval: '1d' } }),
  analyzer('coverage'),
  analyzer('review', { needs: { agent: 'required' } }),
  analyzer('widgets'),
]

const rules = [
  rule({ analyzers: ['coverage'], lanes: ['web', 'pay'], title: 'Coverage nightly' }),
  rule({ analyzers: ['review'], events: ['newRepo'], title: 'New repositories' }),
  rule({ analyzers: ['widgets'], enabled: false }),
]

test('state, scope and triggers come from Automation; overrides from narrower entries', () => {
  const rows = analyzerRows({
    analyzers,
    rules,
    settings: [
      setting('analyzers.licenses', { all: true }),
      setting('analyzers.licenses', { groups: ['web'] }),
      setting('analyzers.licenses', { repos: ['work:acme/web-shop'] }),
    ],
    health: [{ analyzer: 'coverage', runs: 4, failed: 1, blocked: 0, targets: 3 }],
  })
  expect(rows.map((row) => [row.kind, row.area, row.state, row.where, row.overrides])).toEqual([
    ['licenses', 'supply', 'on', 'Every repository', 2],
    ['coverage', 'quality', 'some', 'pay, web', 0],
    ['review', 'quality', 'off', 'Only when started', 0],
    ['widgets', 'other', 'off', 'Only when started', 0],
  ])
  expect(rows[0]?.when).toEqual(['Freshness on change, at most every 1d'])
  expect(rows[1]?.when).toEqual(['Coverage nightly'])
  expect(rows[2]?.ai).toBe(true)
  expect(rows[1]?.health?.failed).toBe(1)
  expect(analyzerCounts(rows)).toEqual({
    all: 4,
    on: 1,
    some: 1,
    off: 2,
    overrides: 2,
    ai: 1,
    warn: 1,
  })
})

test('freshness turned off for every repository leaves only rules', () => {
  const [licenses] = analyzerRows({
    analyzers: [analyzers[0]!],
    rules: [],
    settings: [setting('freshness', { all: true }, { mode: 'off' })],
  })
  expect(licenses).toMatchObject({ state: 'off', when: [] })
})

test('filters by state, area, AI and text', () => {
  const rows = analyzerRows({ analyzers, rules, settings: [] })
  expect(filterAnalyzerRows(rows, { state: 'off' }).map((row) => row.kind)).toEqual([
    'review',
    'widgets',
  ])
  expect(filterAnalyzerRows(rows, { areas: ['quality'], ai: 'no' }).map((r) => r.kind)).toEqual([
    'coverage',
  ])
  expect(filterAnalyzerRows(rows, { q: 'LIC' }).map((row) => row.kind)).toEqual(['licenses'])
  expect(analyzerArea('unknown-kind')).toBe('other')
})

test('health summary in words', () => {
  expect(healthSummary(undefined)).toEqual({ text: 'No runs', tone: 'default' })
  const base = { analyzer: 'x', runs: 4, failed: 0, blocked: 0, targets: 2 }
  expect(healthSummary(base)).toEqual({ text: '4 runs, all fine', tone: 'success' })
  expect(healthSummary({ ...base, failed: 1 })).toEqual({ text: '1 of 4 failed', tone: 'warning' })
  expect(healthSummary({ ...base, failed: 2 }).tone).toBe('danger')
  expect(healthSummary({ ...base, blocked: 1 })).toEqual({
    text: '1 stopped by budget',
    tone: 'warning',
  })
})
