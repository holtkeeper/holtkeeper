import type {
  Action,
  AnalysisSummary,
  HealthTone,
  RepoCardKey,
  RepoCardSegment,
  RepoHealthCellKey,
  RepoOverview,
  RepoUpdatesView,
} from '@holtkeeper/api'

import { formatUsd } from './ai-usage.ts'
import { formatRelative, plural } from './format.ts'
import { type Freshness, compareFreshness, freshnessOf } from './freshness.ts'
import type { RepoHubSearch, RepoHubTab } from './repo.ts'

/** A tab and the permissions that show it. */
export interface PageTab<Id extends string> {
  id: Id
  label: string
  /** Any of these shows the tab; none means everyone. */
  requires?: readonly Action[]
}

/** The repository hub's tabs in display order; also its `tab` search parameter. */
export const repoTabs = [
  { id: 'overview', label: 'Overview', requires: ['analyses:read'] },
  { id: 'supply', label: 'Supply chain', requires: ['analyses:read', 'audits:read'] },
  { id: 'quality', label: 'Quality', requires: ['analyses:read'] },
  { id: 'releases', label: 'Releases', requires: ['releases:read'] },
  { id: 'activity', label: 'Activity', requires: ['repos:read', 'audit:read'] },
  { id: 'knowledge', label: 'Knowledge', requires: ['knowledge:read'] },
  { id: 'settings', label: 'Settings', requires: ['settings:read'] },
] as const satisfies readonly PageTab<RepoHubTab>[]

/** Areas of the hub's Supply chain tab, in display order; its `section` search parameter. */
export const supplySections = [
  { id: 'security', label: 'Security', requires: ['audits:read'] },
  { id: 'libraries', label: 'Libraries', requires: ['analyses:read'] },
  { id: 'licenses', label: 'Licenses', requires: ['analyses:read'] },
  { id: 'stack', label: 'Stack', requires: ['analyses:read'] },
  { id: 'public-api', label: 'Public API', requires: ['analyses:read'] },
] as const satisfies readonly PageTab<RepoCardKey>[]

/** Areas of the hub's Quality tab, in display order; its `section` search parameter. */
export const qualitySections = [
  { id: 'coverage', label: 'Coverage' },
  { id: 'bundles', label: 'Bundles' },
  { id: 'assets', label: 'Assets' },
  { id: 'ci', label: 'CI' },
  { id: 'branches', label: 'Branches' },
  { id: 'reviews', label: 'Reviews' },
] as const satisfies readonly PageTab<string>[]

/** A Quality area of the hub. */
export type QualitySection = (typeof qualitySections)[number]['id']

/** A Supply chain area of the hub. */
export type SupplySection = (typeof supplySections)[number]['id']

/**
 * The hub search that opens `tab` (and `section` of it): the default tab and empty values are
 * left out, so the plain hub URL stays the Overview.
 */
export const hubSearch = (tab: RepoHubTab, section?: string): RepoHubSearch => ({
  ...(tab === 'overview' ? {} : { tab }),
  ...(section ? { section } : {}),
})

/** Where an Overview card opens: its area of the Supply chain or Quality tab. */
export const cardTarget = (card: { key: RepoCardKey; section: 'supply' | 'quality' }) =>
  hubSearch(card.section, card.key)

/** The tabs `can` lets a person see, in display order. */
export const visibleTabs = <T extends PageTab<string>>(
  tabs: readonly T[],
  can: (action: Action) => boolean,
): T[] => tabs.filter((tab) => !tab.requires || tab.requires.some((action) => can(action)))

/** The requested tab when it is visible, else the first visible one. */
export const pickTab = <Id extends string>(
  tabs: readonly { id: Id }[],
  requested: string | undefined,
): Id | undefined => (tabs.find((tab) => tab.id === requested) ?? tabs[0])?.id

/** Records sorted for the freshness list: the most worrying first, then by label. */
export function freshnessRows(
  overview: Pick<RepoOverview, 'analyses' | 'head'>,
  now: Date = new Date(),
): { record: AnalysisSummary; freshness: Freshness }[] {
  return overview.analyses
    .map((record) => ({ record, freshness: freshnessOf(record, overview.head?.sha, now) }))
    .toSorted(
      (a, b) =>
        compareFreshness(a.freshness, b.freshness) || a.record.label.localeCompare(b.record.label),
    )
}

/** Names of the Overview cards. */
export const cardLabels: Record<RepoCardKey, string> = {
  security: 'Security',
  libraries: 'Libraries',
  licenses: 'Licenses',
  stack: 'Stack',
  'public-api': 'Public API',
  coverage: 'Coverage',
  bundles: 'Bundles',
  assets: 'Assets',
  ci: 'CI',
  branches: 'Branches',
}

/** Health cells in the order of the hub's health strip, with their names. */
export const stripCells: readonly { key: RepoHealthCellKey; label: string }[] = [
  { key: 'security', label: 'Security' },
  { key: 'licenses', label: 'Licenses' },
  { key: 'dependencies', label: 'Libraries' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'bundles', label: 'Bundles' },
  { key: 'ci', label: 'CI' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'release', label: 'Releases' },
]

/** A card of the Overview's "Delivery and activity" row. */
export interface DeliveryCard {
  key: 'releases' | 'reviews' | 'work' | 'knowledge'
  label: string
  tone: HealthTone
  status: string
  value: string
  unit: string
  lines: string[]
  segments?: RepoCardSegment[]
}

const shareOf = (part: number, whole: number) => Math.round((part / whole) * 1000) / 1000

/**
 * The Delivery and activity cards of an overview: Releases (with `releases:read`; `Off` while
 * releases are off), AI reviews of 30 days, this week's runs and tasks (tasks and spend only when
 * the overview carries them), and the Guide (with
 * `knowledge:read`, which the overview reflects by carrying `knowledge`).
 */
export function deliveryCards(
  overview: Pick<RepoOverview, 'release' | 'cells' | 'reviews30d' | 'work' | 'knowledge'>,
  canReleases: boolean,
  now: Date = new Date(),
): DeliveryCard[] {
  const cards: DeliveryCard[] = []
  const { release } = overview
  if (canReleases)
    cards.push(
      release
        ? {
            key: 'releases',
            label: 'Releases',
            tone: overview.cells.release?.tone ?? 'info',
            status: overview.cells.release?.value ?? release.stage,
            value: release.latest?.tag ?? '—',
            unit: 'latest tag',
            lines: [
              release.next
                ? `Next ${release.next}${release.bump ? ` · ${release.bump}` : ''}`
                : `${release.unreleased}${release.unreleasedCapped ? '+' : ''} unreleased commits`,
              ...(release.deployed
                ? [
                    `${release.deployed.environment} deploy ${formatRelative(release.deployed.at, now)}`,
                  ]
                : []),
            ],
          }
        : {
            key: 'releases',
            label: 'Releases',
            tone: 'none',
            status: 'Off',
            value: '—',
            unit: 'latest tag',
            lines: ['Releases are off for this repository'],
          },
    )
  const reviews = overview.reviews30d
  const reactions = reviews.up + reviews.down
  const helpful = approvalShare(reviews)
  cards.push({
    key: 'reviews',
    label: 'AI reviews',
    ...(helpful === undefined
      ? { tone: 'none' as const, status: reviews.reviews ? 'No reactions' : 'No reviews' }
      : {
          tone:
            helpful >= 0.7
              ? ('ok' as const)
              : helpful >= 0.4
                ? ('warn' as const)
                : ('bad' as const),
          status: `${Math.round(helpful * 100)}% helpful`,
        }),
    value: String(reviews.reviews),
    unit: 'reviews, 30 days',
    ...(reactions
      ? {
          segments: [
            { tone: 'ok' as const, share: shareOf(reviews.up, reactions) },
            { tone: 'bad' as const, share: shareOf(reviews.down, reactions) },
          ].filter((segment) => segment.share > 0),
        }
      : {}),
    lines: [
      `${plural(reviews.posted, 'comment')} posted · ${reviews.resolved} resolved`,
      `Spend ${formatUsd(reviews.costUsd)}`,
    ],
  })
  const { work } = overview
  cards.push({
    key: 'work',
    label: 'Runs and tasks',
    ...(work.failed
      ? { tone: 'bad' as const, status: `${work.failed} failed` }
      : work.awaitingApproval
        ? { tone: 'warn' as const, status: `${work.awaitingApproval} needs approval` }
        : work.runs
          ? { tone: 'ok' as const, status: 'OK' }
          : { tone: 'none' as const, status: 'Quiet' }),
    value: String(work.runs),
    unit: 'runs this week',
    lines: [
      work.awaitingApproval === undefined
        ? `${work.failed} failed`
        : `${work.failed} failed · ${plural(work.awaitingApproval, 'write task')} waiting`,
      ...(work.costUsd === undefined ? [] : [`AI spend this week ${formatUsd(work.costUsd)}`]),
    ],
  })
  const { knowledge } = overview
  if (knowledge)
    cards.push({
      key: 'knowledge',
      label: 'Knowledge',
      ...(knowledge.proposed
        ? { tone: 'warn' as const, status: `${knowledge.proposed} to review` }
        : knowledge.sections
          ? { tone: 'ok' as const, status: 'Written' }
          : { tone: 'none' as const, status: 'No own sections' }),
      value: String(knowledge.sections),
      unit: 'own guide sections',
      lines: [
        `${plural(knowledge.notes, 'note')} · ${knowledge.proposed} learnings proposed`,
        knowledge.inherits.length
          ? `Inherits ${knowledge.inherits.join(', ')}`
          : 'Inherits nothing',
      ],
    })
  return cards
}

/** The header's Updates tag: how the repository learns about forge changes, in a few words. */
export function updatesBadge(
  view: Pick<RepoUpdatesView, 'viaWebhook' | 'webhookSeenAt' | 'polling'>,
  now: Date = new Date(),
): { tone: HealthTone; text: string } {
  const { polling } = view
  if (polling.lastError) return { tone: 'bad', text: 'Poll failed' }
  if (view.viaWebhook)
    return {
      tone: 'ok',
      text: view.webhookSeenAt
        ? `Webhook OK · ${formatRelative(view.webhookSeenAt, now)}`
        : 'Webhook OK',
    }
  if (polling.enabled)
    return {
      tone: 'info',
      text: polling.lastPolledAt
        ? `Polling · ${formatRelative(polling.lastPolledAt, now)}`
        : 'Polling',
    }
  return { tone: 'none', text: 'Off' }
}

/** What the facts say about Holtkeeper's access to the repository. */
export const accessText = (access: RepoOverview['access']): string =>
  access.readOnly
    ? `Read-only${access.reason ? ` · ${access.reason}` : ''}`
    : access.writeTasks
      ? 'Read and write · agents may open merge requests'
      : 'Read and write · write tasks off'

/** Freshness rows tallied for the table's legend: failed and month-old records count as `bad`. */
export function freshnessTally(rows: readonly { freshness: Freshness }[]) {
  const tally = { current: 0, behind: 0, aging: 0, bad: 0 }
  for (const { freshness } of rows)
    if (freshness === 'failed' || freshness === 'stale') tally.bad++
    else if (freshness !== 'never') tally[freshness]++
  return tally
}

/** 👍 share of all reactions, `undefined` without any. */
export const approvalShare = (reactions: { up: number; down: number }): number | undefined =>
  reactions.up + reactions.down ? reactions.up / (reactions.up + reactions.down) : undefined
