import { describe, expect, test } from 'bun:test'

import { at, deployment, input, mr, options, pipeline, tag } from '../test/history.ts'
import {
  blameFailures,
  computeDora,
  deployEvents,
  failureRateBand,
  failureSignals,
  frequencyBand,
  isHotfix,
  isRevert,
  leadTimeBand,
  restoreBand,
  restoreTimes,
} from './dora.ts'
import { quantile, weekOf, weeksOf } from './stats.ts'
import type { FailureSignal } from './types.ts'

const HOUR = 3600
const DAY = 24 * HOUR

describe('stats', () => {
  test('quantiles interpolate and weeks start on Monday', () => {
    expect(quantile([], 0.5)).toBeUndefined()
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5)
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1)
    expect(weekOf('2026-03-08T23:59:00Z')).toBe('2026-03-02')
    expect(weekOf('2026-03-09T00:00:00+00:00')).toBe('2026-03-09')
    expect(weeksOf(at(0), at(28))).toEqual([
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
      '2026-03-23',
      '2026-03-30',
    ])
  })
})

describe('bands', () => {
  test('follow the DORA thresholds', () => {
    expect([10, 7, 3, 1, 0.5, 0.2].map(frequencyBand)).toEqual([
      'elite',
      'elite',
      'high',
      'high',
      'medium',
      'low',
    ])
    expect([HOUR, DAY, 6 * DAY, 7 * DAY, 40 * DAY].map(leadTimeBand)).toEqual([
      'elite',
      'high',
      'high',
      'medium',
      'low',
    ])
    expect([0, 5, 10, 15, 16].map(failureRateBand)).toEqual([
      'elite',
      'elite',
      'high',
      'medium',
      'low',
    ])
    expect([10 * 60, 2 * HOUR, 2 * DAY, 8 * DAY].map(restoreBand)).toEqual([
      'elite',
      'high',
      'medium',
      'low',
    ])
  })
})

describe('release source', () => {
  test('prefers deployments, then tags, then default-branch pipelines', () => {
    const deployments = [deployment('success', at(1)), deployment('canceled', at(2))]
    const tags = [tag('v1', at(3)), tag('v0', at(-10))]
    const pipelines = [pipeline('success', at(4)), pipeline('success', at(5), { ref: 'feature' })]

    const fromDeployments = deployEvents(input({ deployments, tags, pipelines }))
    expect(fromDeployments.source).toBe('deployments')
    expect(fromDeployments.events).toHaveLength(1)

    const fromTags = deployEvents(
      input({ deployments: [deployment('success', at(-5))], tags, pipelines }),
    )
    expect(fromTags).toEqual({
      source: 'tags',
      events: [{ at: at(3), status: 'success', label: 'v1' }],
    })

    const fromPipelines = deployEvents(input({ pipelines }))
    expect(fromPipelines.source).toBe('pipelines')
    expect(fromPipelines.events.map((e) => e.at)).toEqual([at(4)])

    expect(deployEvents(input()).source).toBe('none')
  })
})

describe('failure signals', () => {
  test('recognize reverts, rollbacks and hotfixes', () => {
    expect(isRevert(mr({ createdAt: at(0), title: 'Revert "feat: x"' }))).toBe(true)
    expect(isRevert(mr({ createdAt: at(0), title: 'Rollback payments' }))).toBe(true)
    expect(isRevert(mr({ createdAt: at(0), title: 'fix: x', labels: ['revert'] }))).toBe(true)
    expect(isRevert(mr({ createdAt: at(0), title: 'feat: reverting logic' }))).toBe(false)
    expect(isHotfix(mr({ createdAt: at(0), labels: ['type::hotfix'] }))).toBe(true)
    expect(isHotfix(mr({ createdAt: at(0), sourceBranch: 'hotfix/login' }))).toBe(true)
    expect(isHotfix(mr({ createdAt: at(0) }))).toBe(false)
  })

  test('only merged merge requests into the default branch count', () => {
    const history = input({
      mergeRequests: [
        mr({ createdAt: at(1), mergedAt: at(1, 2), title: 'Revert "a"' }),
        mr({ createdAt: at(1), title: 'Revert "b"', state: 'open' }),
        mr({ createdAt: at(1), mergedAt: at(1, 2), title: 'Revert "c"', targetBranch: 'release' }),
      ],
    })
    expect(failureSignals(history, []).map((s) => s.title)).toEqual(['Revert "a"'])
  })
})

describe('change failure and restore', () => {
  const events = [
    { at: at(1), status: 'success' as const, label: 'd1' },
    { at: at(1, 5), status: 'failed' as const, label: 'd2' },
    { at: at(2), status: 'success' as const, label: 'd3' },
    { at: at(5), status: 'success' as const, label: 'd4' },
    { at: at(9), status: 'success' as const, label: 'd5' },
  ]

  test('blames each signal on the last release within the window', () => {
    const signals: FailureSignal[] = [
      { kind: 'deployment' as const, at: at(1, 5), fixedAfter: at(1, 5), title: 'failed d2' },
      { kind: 'hotfix' as const, at: at(5, 3), fixedAfter: at(6), title: 'hotfix' },
      { kind: 'revert' as const, at: at(7), fixedAfter: at(7, 1), title: 'late revert' },
    ]
    const failed = blameFailures(events, signals, 24)
    expect([...failed].toSorted((a, b) => a - b)).toEqual([0, 3])
    expect(signals.map((s) => s.blamedOn)).toEqual(['d1', 'd4', undefined])
  })

  test('restores at the first release after the fix and merges overlapping failures', () => {
    const signals: FailureSignal[] = [
      { kind: 'deployment' as const, at: at(1, 5), fixedAfter: at(1, 5), title: 'failed d2' },
      { kind: 'hotfix' as const, at: at(1, 10), fixedAfter: at(3), title: 'hotfix during outage' },
      { kind: 'revert' as const, at: at(9, 1), fixedAfter: at(9, 2), title: 'unresolved' },
    ]
    const result = restoreTimes(events, signals)
    expect(result.incidents).toBe(2)
    expect(result.unresolved).toBe(1)
    // The hotfix merged after d3, so the incident lasts until d4.
    expect(result.durations).toEqual([(3 * 24 + 19) * HOUR])
    expect(signals.map((s) => s.restoreSeconds)).toEqual([
      19 * HOUR,
      (3 * 24 + 14) * HOUR,
      undefined,
    ])
  })
})

describe('computeDora', () => {
  test('computes the four metrics on a synthetic month', () => {
    const deployments = [0, 3, 7, 10, 14, 17, 21, 24].map((day) =>
      deployment('success', at(day, 12)),
    )
    deployments.push(deployment('failed', at(7, 18)))
    const mergeRequests = [
      mr({ createdAt: at(0), mergedAt: at(0, 6) }),
      mr({ createdAt: at(2), mergedAt: at(3) }),
      mr({ createdAt: at(9), mergedAt: at(10, 13), labels: ['hotfix'] }),
      mr({ createdAt: at(25), mergedAt: at(26) }),
      mr({ createdAt: at(1), state: 'open', updatedAt: at(1) }),
    ]
    const dora = computeDora(input({ deployments, mergeRequests }), options)

    expect(dora.source).toBe('deployments')
    expect(dora.deployments).toBe(8)
    expect(dora.failedDeployments).toBe(1)
    expect(dora.deploymentsPerWeek).toBe(2)
    expect(dora.bands.deploymentFrequency).toBe('high')

    // Lead times: 12h, 1.5d, 4.5d (deployed day 14); the last merge has no release after it.
    expect(dora.leadTime.samples).toBe(3)
    expect(dora.leadTime.median).toBe(1.5 * DAY)
    expect(dora.undeployed).toBe(1)
    expect(dora.timeToMerge.median).toBe(DAY)
    expect(dora.bands.leadTime).toBe('high')

    // The failed deploy on day 7 blames day 7's release; the hotfix (created day 9) comes 36 hours after it.
    expect(dora.failedChanges).toBe(1)
    expect(dora.changeFailureRate).toBe(12.5)
    expect(dora.bands.changeFailureRate).toBe('medium')

    // The hotfix starts during the outage of the failed deploy, so both are one incident that
    // lasts until the release after the hotfix merge (14d12h).
    expect(dora.timeToRestore.incidents).toBe(1)
    expect(dora.timeToRestore.median).toBe((6 * 24 + 18) * HOUR)
    expect(dora.bands.timeToRestore).toBe('medium')
    expect(dora.weeks.map((w) => w.deployments)).toEqual([2, 2, 2, 2, 0])
    expect(dora.weeks.map((w) => w.failedChanges)).toEqual([0, 1, 0, 0, 0])
    expect(dora.weeks[0]?.leadTimeMedian).toBe(DAY)
  })

  test('without releases only frequency has a band', () => {
    const dora = computeDora(input(), options)
    expect(dora.source).toBe('none')
    expect(dora.deploymentsPerWeek).toBe(0)
    expect(dora.changeFailureRate).toBeUndefined()
    expect(dora.bands).toEqual({ deploymentFrequency: 'low' })
  })
})
