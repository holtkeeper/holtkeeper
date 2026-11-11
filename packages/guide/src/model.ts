import type { RepoTarget } from '@holtkeeper/access'
import type { GuideScopeKey, GuideSectionName } from '@holtkeeper/store'

export type {
  Family,
  FamilyStore,
  GuideGenerated,
  GuideLearning,
  GuideRevision,
  GuideScopeKey,
  GuideSection,
  GuideSectionInput,
  GuideSectionName,
  GuideStore,
} from '@holtkeeper/store'

/** Every section, in the order prompts and the panel show them. */
export const guideSections = [
  'general',
  'review',
  'testing',
  'testids',
  'assets',
  'commits',
  'releases',
] as const satisfies readonly GuideSectionName[]

/** Headings of the sections in prompts and the panel. */
export const guideSectionLabels: Record<GuideSectionName, string> = {
  general: 'General',
  review: 'Review',
  testing: 'Testing',
  testids: 'Test ids',
  assets: 'Assets',
  commits: 'Commits',
  releases: 'Releases',
}

export const isGuideSection = (value: unknown): value is GuideSectionName =>
  guideSections.some((section) => section === value)

/** A scope parsed from its key. */
export type GuideScope =
  | { kind: 'all' }
  | { kind: 'group'; group: string }
  | { kind: 'family'; family: string }
  | { kind: 'repo'; forge: string; path: string }

/** The key of a scope: `all`, `group:<name>`, `family:<id>` or `repo:<forge>:<path>`. */
export function guideScopeKey(scope: GuideScope): GuideScopeKey {
  if (scope.kind === 'group') return `group:${scope.group}`
  if (scope.kind === 'family') return `family:${scope.family}`
  if (scope.kind === 'repo') return `repo:${scope.forge}:${scope.path}`
  return 'all'
}

/** The scope of a key, or `undefined` when the key is malformed. */
export function parseGuideScope(key: string): GuideScope | undefined {
  if (key === 'all') return { kind: 'all' }
  const separator = key.indexOf(':')
  if (separator < 1) return undefined
  const kind = key.slice(0, separator)
  const rest = key.slice(separator + 1)
  if (!rest) return undefined
  if (kind === 'group') return { kind: 'group', group: rest }
  if (kind === 'family') return { kind: 'family', family: rest }
  if (kind !== 'repo') return undefined
  const split = rest.indexOf(':')
  if (split < 1 || split === rest.length - 1) return undefined
  return { kind: 'repo', forge: rest.slice(0, split), path: rest.slice(split + 1) }
}

/** `forge:path` of a repository, the form families list members in. */
export const repoKey = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

/**
 * The scope keys whose sections apply to `repo`, most specific first: the repository, its family,
 * its groups in config order, then `all`.
 */
export function scopesFor(repo: RepoTarget, family?: string): GuideScopeKey[] {
  return [
    guideScopeKey({ kind: 'repo', forge: repo.forge, path: repo.path }),
    ...(family ? [guideScopeKey({ kind: 'family', family })] : []),
    ...repo.groups.map((group) => guideScopeKey({ kind: 'group', group })),
    'all',
  ]
}

/** What a resolved Guide is for. */
export type GuideTask = 'review' | 'chat' | 'release-notes' | 'agent'

export const guideTasks = [
  'review',
  'chat',
  'release-notes',
  'agent',
] as const satisfies GuideTask[]

export const isGuideTask = (value: unknown): value is GuideTask =>
  guideTasks.some((task) => task === value)

/**
 * The task a run of `taskKind` (as agents report it) resolves the Guide for, with the section
 * its work is about: `review` for reviews and thread replies, `release-notes` for release
 * summaries, `tests` work reads `testing`; everything else is an agent task reading `general`.
 */
export function guideTaskOf(taskKind: string): { task: GuideTask; section?: GuideSectionName } {
  if (taskKind === 'review') return { task: 'review' }
  if (taskKind === 'release-notes') return { task: 'release-notes' }
  if (taskKind === 'chat') return { task: 'chat' }
  if (taskKind === 'tests') return { task: 'agent', section: 'testing' }
  return { task: 'agent' }
}

/**
 * The sections a task reads, in prompt order: a review reads `general`, `review`, `testing`,
 * `testids` and `assets`; release notes read `releases` and `commits`; chat and other agent work
 * read `general` plus the section the work is about.
 */
export function sectionsForTask(task: GuideTask, section?: GuideSectionName): GuideSectionName[] {
  const wanted: GuideSectionName[] =
    task === 'review'
      ? ['general', 'review', 'testing', 'testids', 'assets']
      : task === 'release-notes'
        ? ['releases', 'commits']
        : ['general', ...(section ? [section] : [])]
  return guideSections.filter((name) => wanted.includes(name))
}
