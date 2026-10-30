import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import { memoryStore } from '@holtkeeper/store/memory'

import { releaseRiskAnalyzer } from './analyzer.ts'
import { assessRisk } from './assess.ts'
import { loadRiskInputs, pickPair } from './load.ts'
import { releaseRiskAnalysis, releaseRiskReport } from './report.ts'
import type { ReleaseRiskData } from './schema.ts'
import { deterministicSummary, summarizeRelease } from './summary.ts'
import { audit, bundle, changelog, commit, finding, source } from './test-helpers.ts'

const repo = { forge: 'work', path: 'games/slots' }
const runner = {} as Parameters<typeof releaseRiskAnalyzer.run>[0]['runner']

async function seeded() {
  const store = memoryStore()
  const add = (kind: string, createdAt: string, data: unknown, ref?: string) =>
    store.analyses.add({ repo, kind, createdAt, data, ...(ref ? { ref } : {}) })
  const cl1 = await add(
    'changelog',
    '2026-10-01T00:00:00.000Z',
    changelog([], { to: { name: 'v1' } }),
    'v1',
  )
  const cl2 = await add(
    'changelog',
    '2026-10-10T00:00:00.000Z',
    changelog(
      [
        commit('a', 'feat(cart): coupons', { type: 'feat', scope: 'cart', description: 'coupons' }),
        commit('b', 'fix: crash on start', { type: 'fix', description: 'crash on start' }),
      ],
      { to: { name: 'v2' } },
    ),
    'v2',
  )
  const b1 = await add('bundle', '2026-10-01T00:00:00.000Z', bundle(100_000), 'v1')
  const b2 = await add('bundle', '2026-10-10T00:00:00.000Z', bundle(105_000), 'v2')
  await add('quality', '2026-10-11T00:00:00.000Z', { broken: true })
  await store.analyses.add({
    repo: { forge: 'work', path: 'games/other' },
    kind: 'changelog',
    createdAt: '2026-10-20T00:00:00.000Z',
    ref: 'v9',
    data: changelog([], { to: { name: 'v9' } }),
  })
  await store.auditRuns.add({
    repo,
    trigger: 'cli',
    startedAt: '2026-10-12T00:00:00.000Z',
    finishedAt: '2026-10-12T00:00:00.000Z',
    report: audit([finding('GHSA-1', 'high')]),
  })
  return { store, ids: { cl1: cl1.id, cl2: cl2.id, b1: b1.id, b2: b2.id } }
}

describe('loadRiskInputs', () => {
  test('picks the newest changelog, the bundles of its ref and the one before, and reports unreadable data', async () => {
    const { store, ids } = await seeded()
    const inputs = await loadRiskInputs(store, repo)
    expect(inputs.ref).toBe('v2')
    expect(inputs.changelog?.id).toBe(ids.cl2)
    expect(inputs.bundle?.id).toBe(ids.b2)
    expect(inputs.previousBundle?.id).toBe(ids.b1)
    expect(inputs.audit?.kind).toBe('audit')
    expect(inputs.quality).toBeUndefined()
    expect(inputs.unreadable?.[0]?.input).toBe('quality')
  })

  test('an explicit ref selects that release; bundles must match it', async () => {
    const { store, ids } = await seeded()
    const inputs = await loadRiskInputs(store, repo, 'v1')
    expect(inputs.changelog?.id).toBe(ids.cl1)
    expect(inputs.bundle?.id).toBe(ids.b1)
    expect(inputs.previousBundle).toBeUndefined()
    const none = await loadRiskInputs(store, repo, 'v3')
    expect(none.changelog).toBeUndefined()
    expect(none.bundle).toBeUndefined()
    expect(none.ref).toBe('v3')
  })
})

const record = (id: string, ref?: string) => ({
  id,
  repo,
  kind: 'x',
  createdAt: '',
  data: {},
  ...(ref ? { ref } : {}),
})

const withSummary = (data: ReturnType<typeof assessRisk>): ReleaseRiskData => ({
  ...data,
  summary: { source: 'changelog', markdown: 'text' },
})

test('pickPair skips records of the same ref for the previous one', () => {
  const records = [record('3', 'v2'), record('2', 'v2'), record('1', 'v1')]
  expect(pickPair(records, 'v2', true).map((r) => r?.id)).toEqual(['3', '1'])
  expect(pickPair(records, 'v9', true)).toEqual([undefined, undefined])
  expect(pickPair(records, 'v9', false).map((r) => r?.id)).toEqual(['3', '1'])
})

const fakeAgent = (answer: unknown, seen: AgentTask[] = []): Agent => ({
  name: 'fake',
  async run(task) {
    seen.push(task)
    if (answer instanceof Error) throw answer
    return { text: '', output: answer as never, turns: 1 }
  },
})

describe('summary', () => {
  const inputs = {
    changelog: source(
      'changelog',
      'c',
      changelog([
        commit('a', 'feat(cart)!: new checkout', {
          type: 'feat',
          scope: 'cart',
          breaking: true,
          description: 'new checkout',
        }),
        commit('b', 'fix: crash', { type: 'fix', description: 'crash' }),
        commit('c', 'chore: deps', { type: 'chore' }),
      ]),
    ),
  }
  const assessment = assessRisk(inputs)

  test('deterministic summary lists user changes, test areas and scoring factors', () => {
    const summary = deterministicSummary(assessment, inputs.changelog.data)
    expect(summary.source).toBe('changelog')
    expect(summary.markdown).toContain('**Release v1.1.0.** Risk: **low**')
    expect(summary.markdown).toContain('**Breaking**\n\n- cart: new checkout')
    expect(summary.markdown).toContain('**Fixed**\n\n- crash')
    expect(summary.markdown).not.toContain('deps')
    expect(summary.markdown).toContain('- **cart**: new checkout')
    expect(summary.markdown).toContain('Breaking changes and reverts: 1 breaking change.')
  })

  test('the agent gets read-only capabilities and a structured schema', async () => {
    const seen: AgentTask[] = []
    const agent = fakeAgent(
      {
        overview: 'Checkout was rebuilt.',
        changes: ['New checkout'],
        test: ['Pay with a coupon'],
        risks: [],
      },
      seen,
    )
    const summary = await summarizeRelease(assessment, inputs.changelog.data, { agent })
    expect(summary).toMatchObject({ source: 'agent', agent: 'fake' })
    expect(summary.markdown).toStartWith('Checkout was rebuilt. Risk: **low**')
    expect(summary.markdown).toContain('### What to test\n\n- Pay with a coupon')
    expect(summary.markdown).toContain('### Risks\n\nNothing noteworthy.')
    expect(seen[0]?.capabilities).toEqual(['read', 'search'])
    expect(seen[0]?.output).toBeDefined()
    expect(seen[0]?.prompt).toContain('new checkout')
  })

  test('a failing agent falls back to the changelog summary', async () => {
    const lines: string[] = []
    const summary = await summarizeRelease(assessment, inputs.changelog.data, {
      agent: fakeAgent(new Error('quota')),
      log: (line) => lines.push(line),
    })
    expect(summary.source).toBe('changelog')
    expect(lines[0]).toContain('quota')
  })
})

describe('analyzer and report', () => {
  test('runs from history and returns the release ref', async () => {
    const { store, ids } = await seeded()
    const { data, ref } = await releaseRiskAnalyzer.run({
      repo,
      runner: runner,
      history: store,
      options: releaseRiskAnalyzer.options.parse({ weights: { vulnerabilities: '40' } }),
    })
    expect(ref).toBe('v2')
    expect(releaseRiskAnalysis.schema.parse(data)).toEqual(data)
    expect(data.factors.find((f) => f.id === 'vulnerabilities')?.max).toBe(40)
    expect(data.sources.find((s) => s.kind === 'changelog')?.href).toBe(`/analyses/${ids.cl2}`)
    expect(data.summary.source).toBe('changelog')
  })

  test('fails clearly without history', async () => {
    const error = await releaseRiskAnalyzer
      .run({ repo, runner, options: releaseRiskAnalyzer.options.parse({}) })
      .catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('history')
  })

  test('report compares score and factor points with the previous assessment', () => {
    const previous = withSummary(assessRisk({}))
    const current = withSummary(
      assessRisk({ audit: source('audit', 'r', audit([finding('A', 'critical')])) }),
    )
    const report = releaseRiskReport(current, { previous, generatedAt: 'now' })
    expect(report.metrics[0]).toMatchObject({ id: 'score', value: 25, delta: 25, tone: 'info' })
    expect(report.sections.map((s) => s.id)).toEqual(['summary', 'factors', 'test', 'sources'])
    const factors = report.sections[1]!.blocks
    expect(factors[0]).toMatchObject({
      type: 'issues',
      items: [{ id: 'vulnerabilities', tone: 'bad' }],
    })
    const table = factors[1]
    if (table?.type !== 'table') throw new Error('expected a table')
    expect(table.rows[0]).toMatchObject({ delta: 25, points: 25 })
    expect(table.rows[1]?.points).toEqual({ text: 'unknown', tone: 'neutral' })

    const full = releaseRiskAnalysis.toReport(
      { id: '2', repo, kind: 'release-risk', ref: 'v2', createdAt: '', data: current },
      { id: '1', repo, kind: 'release-risk', ref: 'v1', createdAt: '', data: previous },
    )
    expect(full.subject).toEqual({ repo, ref: 'v2', compareTo: 'v1' })
  })
})
