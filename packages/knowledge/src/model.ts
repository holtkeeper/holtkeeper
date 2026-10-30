import type { RepoTarget } from '@holtkeeper/access'
import type { KnowledgeKind, KnowledgeStatus } from '@holtkeeper/store'

export type {
  KnowledgeContent,
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeFilter,
  KnowledgeHit,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeRevision,
  KnowledgeStatus,
  KnowledgeStore,
} from '@holtkeeper/store'

export const knowledgeKinds = [
  'decision',
  'convention',
  'migration',
  'quirk',
  'howto',
] as const satisfies readonly KnowledgeKind[]

export const knowledgeStatuses = [
  'proposed',
  'accepted',
  'rejected',
  'archived',
] as const satisfies readonly KnowledgeStatus[]

/** Task kinds agents run. `appliesTo` may also hold other kinds, or `*` for every task. */
export const taskKinds = [
  'review',
  'port',
  'propagate',
  'tests',
  'quality',
  'release-risk',
] as const

/**
 * A package a task works on. `from` and `to` are the versions before and after (a propagation of
 * react 18.3.1 → 19.0.0); a range such as `^18.2.0` counts as its lowest version.
 */
export interface TaskPackage {
  ecosystem: string
  name: string
  from?: string
  to?: string
}

/** The task an agent is doing, for picking the knowledge it should read. */
export interface KnowledgeTask {
  /** `review`, `port`, `propagate`, ... */
  kind: string
  repo: RepoTarget
  packages?: TaskPackage[]
  /** Extra text to rank by, e.g. the merge request title. */
  query?: string
}
