import type {
  GroupMatch,
  HomeAttentionItem,
  HomeChange,
  HomeRepoRef,
  HomeRepoStatus,
  HomeRepoTile,
  HomeSeverity,
  HomeSpend,
  HomeView,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { Segment } from '../ui/SegmentBar.tsx'
import type { Tick } from '../ui/TickStrip.tsx'
import { type ScopeView, inHomeGroups } from './home-scope.ts'

/**
 * Whether a row about `refs` belongs to a scope position: rows about no repository belong to
 * every position, others when one of their repositories does.
 */
export function inScope(
  refs: readonly HomeRepoRef[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): boolean {
  if (view === 'all' || !refs.length) return true
  const mine = view === 'mine'
  return refs.some((ref) => inHomeGroups(homeGroups, ref.groups) === mine)
}

/** Home narrowed to a scope position, with the repository counts the scope switch shows. */
export interface ScopedHome {
  attention: HomeAttentionItem[]
  changes: HomeChange[]
  repos: HomeRepoTile[]
  counts: Record<ScopeView, number>
}

/** Narrows Home to a scope position; a UI default, the server already filtered by permission. */
export function scopeHome(
  home: HomeView,
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): ScopedHome {
  const tiles = (position: ScopeView) =>
    home.repos.filter((tile) => inScope([tile], position, homeGroups))
  return {
    attention: home.attention.filter((item) => inScope(item.repos, view, homeGroups)),
    changes: home.changes.filter((change) =>
      inScope(change.repo ? [change.repo] : [], view, homeGroups),
    ),
    repos: tiles(view),
    counts: {
      mine: tiles('mine').length,
      all: home.repos.length,
      others: tiles('others').length,
    },
  }
}

export const severityTone: Record<HomeSeverity, StatusTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'default',
}

export const severityLabel: Record<HomeSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const featureTones: readonly StatusTone[] = ['accent', 'info', 'code']

/** `release-notes` → `Release notes`. */
export const featureLabel = (feature: string): string => {
  const words = feature.replaceAll(/[-_]+/g, ' ').trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Other'
}

/** The spend bar: the `top` largest features, then the rest as one segment. */
export function spendSegments(spend: Pick<HomeSpend, 'byFeature'>, top = 3): Segment[] {
  const head = spend.byFeature.slice(0, top).map((entry, index) => ({
    value: entry.costUsd,
    tone: featureTones[index % featureTones.length]!,
    label: featureLabel(entry.feature),
  }))
  const rest = spend.byFeature.slice(top).reduce((sum, entry) => sum + entry.costUsd, 0)
  return rest > 0 ? [...head, { value: rest, tone: 'default', label: 'Other' }] : head
}

const statusTones: Record<HomeRepoStatus['tone'], Tick['tone']> = {
  ok: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  none: 'skipped',
}

const statusNames: Record<HomeRepoStatus['key'], string> = {
  jobs: 'Jobs',
  vulnerabilities: 'Vulnerabilities',
  release: 'Release',
  analyses: 'Analyses',
}

/** The tick strip of a repository tile, one labeled tick per status. */
export const repoTicks = (tile: Pick<HomeRepoTile, 'status'>): Tick[] =>
  tile.status.map((status) => ({
    tone: statusTones[status.tone],
    label: `${statusNames[status.key]}: ${status.label}`,
  }))

/** The tile's worst status first, for sorting the grid: danger, warning, info, ok, none. */
export function tileRank(tile: Pick<HomeRepoTile, 'status'>): number {
  const order: HomeRepoStatus['tone'][] = ['danger', 'warning', 'info', 'ok', 'none']
  return Math.min(...tile.status.map((status) => order.indexOf(status.tone)), order.length)
}
