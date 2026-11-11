import type {
  Family,
  GroupMatch,
  GuideGenerated,
  GuidePreview,
  GuideScopeKey,
  GuideSection,
  GuideSectionName,
  GuideTask,
  LearningCandidate,
  RegenerateGuideInput,
  RepoRef,
  RepoSummary,
  Scope,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { ScopeView } from './home-scope.ts'
import { parseRepoKey, repoKey } from './repo.ts'
import { namesFocus } from './scope.ts'

/** The fixed Guide sections in the order the server and prompts use, with what each is for. */
export const guideSections: readonly { id: GuideSectionName; label: string; hint: string }[] = [
  { id: 'general', label: 'General', hint: 'Layout, commands, tooling and traps of the code' },
  { id: 'review', label: 'Review', hint: 'What reviews look for and what they leave alone' },
  { id: 'testing', label: 'Testing', hint: 'How tests are written and run' },
  { id: 'testids', label: 'Test ids', hint: 'Where test ids go and how they are named' },
  { id: 'assets', label: 'Assets', hint: 'Images, fonts and media' },
  { id: 'commits', label: 'Commits', hint: 'Commit messages, branches and merge request titles' },
  { id: 'releases', label: 'Releases', hint: 'Release notes style' },
]

export const sectionLabel = (section: GuideSectionName): string =>
  guideSections.find((s) => s.id === section)?.label ?? section

/** A section the `guide` analyzer writes generated text for. */
export type GeneratedSection = NonNullable<RegenerateGuideInput['sections']>[number]

const generatedSections: readonly GeneratedSection[] = ['general', 'testing', 'testids', 'commits']

export const isGeneratedSection = (section: GuideSectionName): section is GeneratedSection =>
  generatedSections.some((s) => s === section)

/** Sections whose text an LLM writes; only they take a steering prompt (`commits` is inferred). */
export const isSteerableSection = (section: GuideSectionName): boolean =>
  isGeneratedSection(section) && section !== 'commits'

/** The setting holding a section's machine-enforced policy, for sections that have one. */
export const sectionPolicies: Partial<Record<GuideSectionName, string>> = {
  testids: 'analyzers.testids',
  assets: 'assets.policy',
  commits: 'commits.conventions',
}

/** Tasks the effective prompt preview resolves the Guide for. */
export const guideTasks: readonly { id: GuideTask; label: string }[] = [
  { id: 'review', label: 'Review' },
  { id: 'chat', label: 'Chat' },
  { id: 'release-notes', label: 'Release notes' },
  { id: 'agent', label: 'Agent task' },
]

/** The tabs of a Knowledge space in display order; also the page's `tab` search parameter. */
export const knowledgeTabs = ['guide', 'notes', 'learnings'] as const

export type KnowledgeTab = (typeof knowledgeTabs)[number]

/** The Knowledge page's search parameters: the space key and the tab, dropping unknown values. */
export function knowledgeSearch(search: Record<string, unknown>): {
  space?: string
  tab?: KnowledgeTab
} {
  const space =
    typeof search.space === 'string' && parseSpace(search.space) ? search.space : undefined
  const tab = knowledgeTabs.find((t) => t === search.tab)
  return { ...(space ? { space } : {}), ...(tab ? { tab } : {}) }
}

/** A Knowledge space: what the sidebar selects and the Guide, Notes and Learnings tabs show. */
export type Space =
  | { kind: 'all' }
  | { kind: 'group'; group: string }
  | { kind: 'family'; family: string }
  | { kind: 'repo'; repo: RepoRef }

/** The Guide scope key of a space, also used as the `space` search parameter. */
export function spaceKey(space: Space): GuideScopeKey {
  if (space.kind === 'group') return `group:${space.group}`
  if (space.kind === 'family') return `family:${space.family}`
  if (space.kind === 'repo') return `repo:${repoKey(space.repo)}`
  return 'all'
}

/** The space of a key; `undefined` for a missing or malformed key. */
export function parseSpace(key: string | undefined): Space | undefined {
  if (key === 'all') return { kind: 'all' }
  if (!key) return undefined
  const separator = key.indexOf(':')
  const kind = key.slice(0, separator)
  const rest = key.slice(separator + 1)
  if (separator < 1 || !rest) return undefined
  if (kind === 'group') return { kind: 'group', group: rest }
  if (kind === 'family') return { kind: 'family', family: rest }
  if (kind !== 'repo') return undefined
  const repo = parseRepoKey(rest)
  return repo ? { kind: 'repo', repo } : undefined
}

/** A scope key in words: `All repositories`, `Team games`, the family's name, a repository path. */
export function scopeLabel(key: GuideScopeKey, families: readonly Family[]): string {
  const space = parseSpace(key)
  if (!space) return key
  if (space.kind === 'all') return 'All repositories'
  if (space.kind === 'group') return `Team ${space.group}`
  if (space.kind === 'family')
    return families.find((f) => f.id === space.family)?.name ?? 'Unknown family'
  return space.repo.path
}

/** A family under one team, with the members that are in that team. */
export interface FamilyNode {
  family: Family
  repos: RepoRef[]
}

/** A team (config group) with its families and the repositories in no family. */
interface TeamNode {
  group: string
  families: FamilyNode[]
  repos: RepoRef[]
}

/** The spaces sidebar below *All*: teams in scope, repositories in no group, and folding counts. */
export interface SpaceTree {
  teams: TeamNode[]
  /** Repositories in no group, shown unless the view is *My team*. */
  ungrouped: { families: FamilyNode[]; repos: RepoRef[] }
  /** Teams per scope switch position. */
  counts: Record<ScopeView, number>
  /** Teams the view hides. */
  folded: number
}

const byPath = (a: RepoRef, b: RepoRef) => repoKey(a).localeCompare(repoKey(b))

const isHomeTeam = (homeGroups: readonly GroupMatch[], group: string) =>
  homeGroups.some((entry) => (typeof entry === 'string' ? entry === group : entry.includes(group)))

function nest(repos: readonly RepoRef[], families: readonly Family[]) {
  const keys = new Set(repos.map(repoKey))
  const inFamily = new Set<string>()
  const nodes = families.flatMap((family): FamilyNode[] => {
    const members = family.members.filter((member) => keys.has(member))
    for (const member of members) inFamily.add(member)
    const refs = members.flatMap((member) => parseRepoKey(member) ?? [])
    return refs.length ? [{ family, repos: refs.toSorted(byPath) }] : []
  })
  return {
    families: nodes.toSorted((a, b) => a.family.name.localeCompare(b.family.name)),
    repos: repos.filter((repo) => !inFamily.has(repoKey(repo))).toSorted(byPath),
  }
}

/**
 * Teams → families → repositories for the spaces sidebar. A repository in several groups shows
 * under each; a family shows under every team holding a member, listing the members of that team.
 * *My team* keeps the viewer's home teams (a team named in a `frontend + storefront` home entry
 * counts), *Other teams* the rest.
 */
export function buildSpaceTree(
  repos: readonly RepoSummary[],
  families: readonly Family[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): SpaceTree {
  const groups = [...new Set(repos.flatMap((r) => r.groups))].toSorted()
  const home = groups.filter((group) => isHomeTeam(homeGroups, group))
  const shown =
    view === 'mine'
      ? home
      : view === 'others'
        ? groups.filter((group) => !home.includes(group))
        : groups
  const teams = shown.map((group) => ({
    group,
    ...nest(
      repos.filter((r) => r.groups.includes(group)).map((r) => r.repo),
      families,
    ),
  }))
  const ungrouped =
    view === 'mine'
      ? { families: [], repos: [] }
      : nest(
          repos.filter((r) => r.groups.length === 0).map((r) => r.repo),
          families,
        )
  return {
    teams,
    ungrouped,
    counts: { mine: home.length, all: groups.length, others: groups.length - home.length },
    folded: groups.length - shown.length,
  }
}

/** `forge:path` of every repository a space covers; `undefined` for *All*, which covers all. */
export function reposOfSpace(
  space: Space,
  repos: readonly RepoSummary[],
  families: readonly Family[],
): ReadonlySet<string> | undefined {
  if (space.kind === 'all') return undefined
  if (space.kind === 'repo') return new Set([repoKey(space.repo)])
  if (space.kind === 'family')
    return new Set(families.find((f) => f.id === space.family)?.members ?? [])
  return new Set(repos.filter((r) => r.groups.includes(space.group)).map((r) => repoKey(r.repo)))
}

/** The settings scope a policy entry made in a space starts with; a family names its members. */
export function settingScopeOfSpace(space: Space, members: readonly string[] = []): Scope {
  if (space.kind === 'group') return { groups: [space.group] }
  if (space.kind === 'repo') return { repos: [repoKey(space.repo)] }
  if (space.kind === 'family') return { repos: [...members] }
  return { all: true }
}

/** Whether a settings entry was made for the space itself, not merely covering it. */
export function entryNamesSpace(scope: Scope, space: Space, members: readonly string[] = []) {
  if (space.kind === 'all') return scope.all === true
  if (space.kind === 'group') return namesFocus(scope, { kind: 'group', group: space.group })
  const repos =
    space.kind === 'repo' ? [space.repo] : members.flatMap((member) => parseRepoKey(member) ?? [])
  return repos.some((repo) => namesFocus(scope, { kind: 'repo', repo }))
}

/** Candidates of the repositories a space covers. */
export const candidatesInSpace = <T extends Pick<LearningCandidate, 'repo'>>(
  candidates: readonly T[],
  covered: ReadonlySet<string> | undefined,
): T[] => (covered ? candidates.filter((c) => covered.has(c.repo)) : [...candidates])

/** The generated text waiting for a person: a newer proposal, or a first one nobody accepted. */
export const pendingGenerated = (section: GuideSection): GuideGenerated | undefined =>
  section.proposal ?? (section.generated?.status === 'proposed' ? section.generated : undefined)

/** Whether a section has anything in it: rules, steering, generated text or learnings. */
export const sectionIsEmpty = (section: GuideSection): boolean =>
  !section.rules.trim() &&
  !section.steering.trim() &&
  !section.generated &&
  !section.proposal &&
  section.learnings.length === 0

/** The preview budget as segments: human text, generated text and notes, against the total. */
export function budgetSegments(
  budget: GuidePreview['budget'],
): { value: number; tone: StatusTone; label: string }[] {
  return [
    { value: budget.humanUsed, tone: 'accent', label: 'human characters' },
    { value: budget.generatedUsed, tone: 'code', label: 'generated characters' },
    { value: budget.notesUsed, tone: 'info', label: 'note characters' },
  ]
}

/** Problems that keep a family from saving: a name and at least two known repositories. */
export function familyProblems(
  draft: { name: string; members: readonly string[] },
  known: ReadonlySet<string>,
): string[] {
  const problems: string[] = []
  if (!draft.name.trim()) problems.push('Add a name')
  if (new Set(draft.members).size < 2) problems.push('Add at least two repositories')
  const unknown = draft.members.find((member) => !known.has(member))
  if (unknown) problems.push(`${unknown} is not a known repository`)
  return problems
}
