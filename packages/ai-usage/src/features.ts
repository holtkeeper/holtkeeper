/** Product areas spend is reported and filtered by, derived from a run's task kind. */
export type AiFeature =
  | 'reviews'
  | 'tasks'
  | 'chat'
  | 'knowledge'
  | 'releases'
  | 'security'
  | 'other'

/** Display name of each feature. */
export const featureLabel: Record<AiFeature, string> = {
  reviews: 'Reviews',
  tasks: 'Agent tasks',
  chat: 'Chat',
  knowledge: 'Rules and learnings',
  releases: 'Releases and QA',
  security: 'Vulnerability triage',
  other: 'Other',
}

/** A feature with a fixed list of task kinds: every one but `other`. */
export type FilterableFeature = Exclude<AiFeature, 'other'>

/** The task kinds each named feature covers; `other` is every kind none of them lists. */
export const featureTaskKinds: Readonly<Record<FilterableFeature, readonly string[]>> = {
  reviews: ['review', 'review-plan', 'review-verify', 'review-split', 'triage', 'translate'],
  tasks: ['write-task', 'fix', 'port', 'propagate', 'upgrade', 'propagate-fix', 'tests'],
  chat: ['chat', 'chat-summary', 'ask'],
  knowledge: ['learning', 'library-digest', 'rule-miner'],
  releases: [
    'release-notes',
    'qa-notes',
    'upgrade-plan',
    'upgrade-check',
    'release-compare-parse',
    'release-compare-summary',
  ],
  security: ['security-triage'],
}

/** Features a filter can narrow to, in display order. */
export const filterableFeatures: readonly FilterableFeature[] = [
  'reviews',
  'tasks',
  'chat',
  'knowledge',
  'releases',
  'security',
]

/** Whether `value` names a feature a filter can narrow to. */
export const isFilterableFeature = (value: string): value is FilterableFeature =>
  filterableFeatures.some((feature) => feature === value)

/** The feature a run of `taskKind` belongs to; unknown and empty kinds are `other`. */
export function featureOf(taskKind: string): AiFeature {
  return (
    filterableFeatures.find((feature) => featureTaskKinds[feature].includes(taskKind)) ?? 'other'
  )
}
