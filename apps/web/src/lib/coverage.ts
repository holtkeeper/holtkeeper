import type { CoverageRepoCard, CoverageTrendPoint } from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { Segment } from '../ui/SegmentBar.tsx'
import type { Tick } from '../ui/TickStrip.tsx'
import { formatDate } from './format.ts'

interface Counts {
  covered: number
  total: number
}

/** Line coverage from which a share reads as good, and below which it reads as bad. */
const thresholds = { good: 80, bad: 50 }

/** Days after which a coverage record reads as aging, then stale. */
const freshDays = { aging: 7, stale: 30 }

/** Share covered, 0..100; `undefined` when there is nothing to cover. */
export const percentOf = (counts: Counts | undefined): number | undefined =>
  counts && counts.total > 0 ? (counts.covered / counts.total) * 100 : undefined

/** Tone of a coverage share, as the coverage report colors it. */
export function coverageTone(percent: number | undefined): StatusTone {
  if (percent === undefined) return 'default'
  if (percent >= thresholds.good) return 'success'
  return percent >= thresholds.bad ? 'warning' : 'danger'
}

/** A share as `87.5%`, or `—` when there is nothing to cover. */
export const formatPercent = (percent: number | undefined): string =>
  percent === undefined ? '—' : `${Math.round(percent * 10) / 10}%`

/** A change in points as `+2.5 pt` or `−1 pt`; empty for no change. */
export function formatPoints(points: number | undefined): string {
  if (points === undefined || Math.abs(points) < 0.05) return ''
  const rounded = Math.round(Math.abs(points) * 10) / 10
  return `${points > 0 ? '+' : '−'}${rounded} pt`
}

/** Tone of a change in points: gains good, losses bad. */
export const pointsTone = (points: number | undefined): StatusTone =>
  points === undefined || Math.abs(points) < 0.05 ? 'default' : points > 0 ? 'success' : 'danger'

/**
 * Lines to cover split into covered, uncovered in tested files and in files no test loaded, for a
 * `SegmentBar`.
 */
export function lineSegments(totals: CoverageRepoCard['totals']): Segment[] {
  const uncovered = totals.lines.total - totals.lines.covered
  const untested = Math.min(totals.untestedLines, uncovered)
  return [
    { value: totals.lines.covered, tone: 'success', label: 'covered lines' },
    { value: uncovered - untested, tone: 'warning', label: 'uncovered lines' },
    { value: untested, tone: 'danger', label: 'lines in files without tests' },
  ]
}

/** One tick per record, oldest first, toned by its line coverage, for a `TickStrip`. */
export const trendTicks = (trend: readonly CoverageTrendPoint[]): Tick[] =>
  trend.map((point) => ({
    tone: point.lines === undefined ? 'skipped' : coverageTone(point.lines),
    label: `${formatDate(point.at)}: ${formatPercent(point.lines)} of lines`,
  }))

type CoverageFreshness = 'fresh' | 'behind' | 'aging' | 'stale'

/** How current a card is: its age first, then whether the default branch moved past its commit. */
export function coverageFreshness(
  card: Pick<CoverageRepoCard, 'createdAt' | 'head'>,
  now: Date = new Date(),
): CoverageFreshness {
  const days = (now.getTime() - new Date(card.createdAt).getTime()) / 86_400_000
  if (days > freshDays.stale) return 'stale'
  if (days > freshDays.aging) return 'aging'
  return card.head ? 'behind' : 'fresh'
}

/** Tone of each freshness state. */
export const freshnessTone: Record<CoverageFreshness, StatusTone> = {
  fresh: 'success',
  behind: 'info',
  aging: 'warning',
  stale: 'danger',
}

/** Short label of each freshness state. */
export const freshnessLabel: Record<CoverageFreshness, string> = {
  fresh: 'Current',
  behind: 'Behind HEAD',
  aging: 'Over a week old',
  stale: 'Over a month old',
}

/** Short commit id. */
export const shortSha = (sha: string): string => sha.slice(0, 8)

/** Cards with the lowest line coverage first, cards without lines to cover last. */
export const sortCoverageCards = <T extends Pick<CoverageRepoCard, 'repo' | 'totals'>>(
  cards: readonly T[],
): T[] =>
  cards.toSorted(
    (a, b) =>
      (percentOf(a.totals.lines) ?? 101) - (percentOf(b.totals.lines) ?? 101) ||
      a.repo.path.localeCompare(b.repo.path),
  )
