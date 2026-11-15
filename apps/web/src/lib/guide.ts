import type {
  DiffHunk,
  DiffLine,
  Family,
  GuideChainLayer,
  GuideChainView,
  GuideGenerated,
  GuideLayer,
  GuideScopeKey,
  GuideSection,
  GuideSectionName,
  GuideTask,
  KnowledgeCounts,
  LearningCandidate,
  RegenerateGuideInput,
  RepoRef,
  RepoSummary,
  Scope,
} from '@holtkeeper/api'
import { folderPattern, pathAncestors } from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { type ScopeCounts, type ScopeView, teamCounts, viewTeam } from './home-scope.ts'
import { parseRepoKey, repoKey } from './repo.ts'
import { type FolderNode, folderTree } from './repos.ts'
import { namesFocus } from './scope.ts'
import { type TeamTitleOf, keyAsTitle } from './team-titles.ts'

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

/** The tabs of a Knowledge space in display order; each is a path, `/knowledge/<tab>`. */
const knowledgeTabs = ['handbook', 'guide', 'notes', 'learnings'] as const

export type KnowledgeTab = (typeof knowledgeTabs)[number]

/** The Knowledge tab a pathname shows; `handbook` when the path names none. */
export const knowledgeTabOf = (pathname: string): KnowledgeTab =>
  knowledgeTabs.find((tab) => pathname.replace(/\/+$/, '').endsWith(`/knowledge/${tab}`)) ??
  'handbook'

/** What a Knowledge link opens: a space, a Guide section of it and a note by id. */
export interface KnowledgeSearch {
  space?: string
  section?: GuideSectionName
  note?: string
}

const isSectionName = (value: unknown): value is GuideSectionName =>
  guideSections.some((s) => s.id === value)

/** The Knowledge page's search parameters, dropping unknown and malformed values. */
export function knowledgeSearch(search: Record<string, unknown>): KnowledgeSearch {
  const space =
    typeof search.space === 'string' && parseSpace(search.space) ? search.space : undefined
  const section = isSectionName(search.section) ? search.section : undefined
  const note = typeof search.note === 'string' && search.note.trim() ? search.note : undefined
  return { ...(space ? { space } : {}), ...(section ? { section } : {}), ...(note ? { note } : {}) }
}

/** A Knowledge space: what the sidebar selects and the Guide, Notes and Learnings tabs show. */
export type Space =
  | { kind: 'all' }
  | { kind: 'team'; team: string }
  | { kind: 'path'; forge: string; folder: string }
  | { kind: 'family'; family: string }
  | { kind: 'repo'; repo: RepoRef }

/** The Guide scope key of a space, also used as the `space` search parameter. */
export function spaceKey(space: Space): GuideScopeKey {
  if (space.kind === 'team') return `team:${space.team}`
  if (space.kind === 'path') return `path:${space.forge}:${space.folder}`
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
  if (kind === 'team') return { kind: 'team', team: rest }
  if (kind === 'family') return { kind: 'family', family: rest }
  if (kind === 'path') {
    const repo = parseRepoKey(rest)
    return repo ? { kind: 'path', forge: repo.forge, folder: repo.path } : undefined
  }
  if (kind !== 'repo') return undefined
  const repo = parseRepoKey(rest)
  return repo ? { kind: 'repo', repo } : undefined
}

/**
 * A scope key in words: `All repositories`, `Team Widgets` (by `titleOf`), `Folder acme/round`,
 * the family's name, a repository path.
 */
export function scopeLabel(
  key: GuideScopeKey,
  families: readonly Family[],
  titleOf: TeamTitleOf = keyAsTitle,
): string {
  const space = parseSpace(key)
  if (!space) return key
  if (space.kind === 'all') return 'All repositories'
  if (space.kind === 'team') return `Team ${titleOf(space.team)}`
  if (space.kind === 'path') return `Folder ${space.folder}`
  if (space.kind === 'family')
    return families.find((f) => f.id === space.family)?.name ?? 'Unknown family'
  return space.repo.path
}

/** A family under one team, with the members that team owns. */
export interface FamilyNode {
  family: Family
  repos: RepoRef[]
}

/** A team with its families and the repositories it owns in no family. */
export interface TeamNode {
  team: string
  families: FamilyNode[]
  repos: RepoRef[]
}

/**
 * The spaces sidebar below *All*: teams in scope, repositories no team owns, the folders of the
 * repositories in scope, and folding counts.
 */
export interface SpaceTree {
  teams: TeamNode[]
  /** Teams the view folds into the collapsed *Other teams* row. */
  others: TeamNode[]
  /** Repositories of the folded teams that no shown team owns. */
  otherRepos: number
  /** Repositories no team owns, shown on *All I can see* only. */
  unowned: { families: FamilyNode[]; repos: RepoRef[] }
  /** The folder tree of the repositories in scope (`folderTree`). */
  folders: FolderNode[]
  /** Teams per scope position, repositories per team. */
  counts: ScopeCounts
  /** Teams the view hides. */
  folded: number
}

const byPath = (a: RepoRef, b: RepoRef) => repoKey(a).localeCompare(repoKey(b))

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
 * Teams → families → repositories for the spaces sidebar, plus the folder tree. A repository
 * shows under every team owning it, and a family under every team owning a member, listing that
 * team's members. *My teams* keeps the viewer's home teams and folds the others, nothing without
 * home teams; a team position keeps that one team and folds nothing. The folders cover the
 * repositories the position keeps. Every count of the switch counts repositories.
 */
export function buildSpaceTree(
  repos: readonly RepoSummary[],
  families: readonly Family[],
  view: ScopeView,
  homeTeams: readonly string[],
): SpaceTree {
  const all = [...new Set(repos.flatMap((r) => r.teams))].toSorted()
  const home = all.filter((team) => homeTeams.includes(team))
  const picked = viewTeam(view)
  const selected =
    view === 'mine' ? home : picked === undefined ? all : all.filter((t) => t === picked)
  const node = (team: string): TeamNode => ({
    team,
    ...nest(
      repos.filter((r) => r.teams.includes(team)).map((r) => r.repo),
      families,
    ),
  })
  const inSelected = (r: RepoSummary) => r.teams.some((team) => selected.includes(team))
  const others =
    view === 'mine' && homeTeams.length
      ? all.filter((team) => !selected.includes(team)).map(node)
      : []
  const unowned =
    view !== 'all'
      ? { families: [], repos: [] }
      : nest(
          repos.filter((r) => r.teams.length === 0).map((r) => r.repo),
          families,
        )
  return {
    teams: selected.map(node),
    others,
    otherRepos: repos.filter((r) => r.teams.length > 0 && !inSelected(r)).length,
    unowned,
    folders: folderTree(repos.filter((r) => view === 'all' || inSelected(r)).map((r) => r.repo)),
    counts: {
      mine: repos.filter((r) => r.teams.some((team) => home.includes(team))).length,
      all: repos.length,
      teams: teamCounts(repos.map((r) => r.teams)),
    },
    folded: others.length,
  }
}

const inFolder = (repo: RepoRef, forge: string, folder: string) =>
  repo.forge === forge && repo.path.startsWith(`${folder}/`)

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
  const covers =
    space.kind === 'team'
      ? (r: RepoSummary) => r.teams.includes(space.team)
      : (r: RepoSummary) => inFolder(r.repo, space.forge, space.folder)
  return new Set(repos.filter(covers).map((r) => repoKey(r.repo)))
}

/**
 * The settings scope a policy entry or note made in a space starts with: the team, the folder's
 * pattern (`forge:folder/**`), a family's members, the repository, or everything.
 */
export function settingScopeOfSpace(space: Space, members: readonly string[] = []): Scope {
  if (space.kind === 'team') return { teams: [space.team] }
  if (space.kind === 'path') return { repos: [folderPattern(space.folder, space.forge)] }
  if (space.kind === 'repo') return { repos: [repoKey(space.repo)] }
  if (space.kind === 'family') return { repos: [...members] }
  return { all: true }
}

/** Whether a settings entry was made for the space itself, not merely covering it. */
export function entryNamesSpace(scope: Scope, space: Space, members: readonly string[] = []) {
  if (space.kind === 'all') return scope.all === true
  if (space.kind === 'team') return namesFocus(scope, { kind: 'team', team: space.team })
  if (space.kind === 'path') {
    const own = [folderPattern(space.folder, space.forge), folderPattern(space.folder)]
    return (scope.repos ?? []).some((pattern) => own.includes(pattern))
  }
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

/** A Guide budget: the caps and what is used of them. */
interface GuideBudget {
  total: number
  used: number
  humanUsed: number
  generatedUsed: number
  notesUsed?: number
  repoFiles?: number
}

/**
 * The 12k budget as named segments: human text, generated text, notes and what is free, summing
 * to the total (free is never negative).
 */
export function budgetSegments(
  budget: GuideBudget,
): { key: string; value: number; tone: StatusTone; label: string }[] {
  const notes =
    budget.notesUsed ?? Math.max(0, budget.used - budget.humanUsed - budget.generatedUsed)
  return [
    { key: 'Human', value: budget.humanUsed, tone: 'accent', label: 'human characters' },
    { key: 'Generated', value: budget.generatedUsed, tone: 'code', label: 'generated characters' },
    { key: 'Notes', value: notes, tone: 'info', label: 'note characters' },
    {
      key: 'Free',
      value: Math.max(0, budget.total - budget.humanUsed - budget.generatedUsed - notes),
      tone: 'default',
      label: 'free characters',
    },
  ]
}

/** About how many tokens `chars` characters of prompt take. */
export const tokensOf = (chars: number): number => Math.round(chars / 4)

/** The letter and name of a chain layer kind, as the Guide's legend shows them. */
export const layerKinds: Readonly<Record<GuideLayer, { letter: string; label: string }>> = {
  'repo-file': { letter: 'D', label: 'Repository files' },
  repo: { letter: 'R', label: 'Repository' },
  family: { letter: 'F', label: 'Family' },
  path: { letter: 'S', label: 'Folder' },
  team: { letter: 'T', label: 'Team' },
  all: { letter: 'O', label: 'All repositories' },
  learnings: { letter: 'L', label: 'Learned' },
  policies: { letter: 'P', label: 'Policies' },
  generated: { letter: 'A', label: 'Generated' },
  notes: { letter: 'N', label: 'Notes' },
  neighbours: { letter: 'K', label: 'Similar repositories' },
}

/** The kinds the sections table shows a column of letters for, broadest first. */
export const tableLayerKinds: readonly GuideLayer[] = [
  'all',
  'team',
  'path',
  'family',
  'repo',
  'learnings',
  'generated',
]

/** One row of the Guide's sections table. */
interface SectionRow {
  section: GuideSectionName
  label: string
  /** Kinds of `tableLayerKinds` that give the section text. */
  layers: ReadonlySet<GuideLayer>
  /** Non-empty lines of this space's own rules. */
  rules: number
  version: number
  updatedAt?: string
  status: 'proposal' | 'set' | 'inherited' | 'empty'
}

const ownKind = (scope: GuideScopeKey): GuideLayer =>
  scope === 'all'
    ? 'all'
    : scope.startsWith('team:')
      ? 'team'
      : scope.startsWith('path:')
        ? 'path'
        : scope.startsWith('family:')
          ? 'family'
          : 'repo'

/**
 * The sections table of a space: one row per section in `guideSections` order. Layers come from
 * the repository's chain when there is one, else from the space's own rules and learnings; status
 * says whether a proposal waits, the space sets rules, only other layers apply, or nothing does.
 */
export function sectionRows(
  sections: readonly GuideSection[],
  chain?: Pick<GuideChainView, 'sections'>,
): SectionRow[] {
  return guideSections.flatMap((meta) => {
    const own = sections.find((s) => s.section === meta.id)
    if (!own) return []
    const fromChain = chain?.sections.find((s) => s.section === meta.id)?.layers
    const layers = new Set<GuideLayer>(
      fromChain
        ? fromChain.map((layer) => layer.kind)
        : [
            ...(own.rules.trim() ? [ownKind(own.scope)] : []),
            ...(own.learnings.length ? (['learnings'] as const) : []),
            ...(own.generated ? (['generated'] as const) : []),
          ],
    )
    const kept = new Set(tableLayerKinds.filter((kind) => layers.has(kind)))
    const rules = own.rules.split('\n').filter((line) => line.trim()).length
    return [
      {
        section: meta.id,
        label: meta.label,
        layers: kept,
        rules,
        version: own.version,
        ...(own.editedAt ? { updatedAt: own.editedAt } : {}),
        status: pendingGenerated(own)
          ? 'proposal'
          : rules > 0
            ? 'set'
            : layers.size > 0
              ? 'inherited'
              : 'empty',
      },
    ]
  })
}

/** Words for a section row's status, and its tone. */
export const sectionStatus: Readonly<
  Record<SectionRow['status'], { label: string; tone: StatusTone }>
> = {
  proposal: { label: 'Proposal waiting', tone: 'warning' },
  set: { label: 'Set here', tone: 'success' },
  inherited: { label: 'Inherited', tone: 'default' },
  empty: { label: 'Not set', tone: 'default' },
}

/** A layer's text without the headings the prompt puts above it. */
export const layerBody = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^#{1,3} /.test(line))
    .join('\n')
    .replace(/^Generated from repository signals, lower priority;[^\n]*\n?/m, '')
    .trim()

/** One step of the space trail above the page title. */
interface SpaceCrumb {
  label: string
  space: Space
}

const teamCrumb = (team: string | undefined, titleOf: TeamTitleOf): SpaceCrumb[] =>
  team ? [{ label: titleOf(team), space: { kind: 'team', team } }] : []

const folderCrumbs = (forge: string, path: string): SpaceCrumb[] =>
  pathAncestors(path)
    .toReversed()
    .map((folder) => ({ label: folder, space: { kind: 'path', forge, folder } }))

const familyCrumb = (family: Family): SpaceCrumb => ({
  label: family.name,
  space: { kind: 'family', family: family.id },
})

/**
 * The trail of spaces from *All* to `space`: All, the team, the family, the repository. A
 * repository's team is its first owner team; a family's team is the first owner team of its first
 * member the viewer sees. A folder's trail passes its parent folders. Teams are labelled by
 * `titleOf` (default their keys).
 */
export function spaceTrail(
  space: Space,
  repos: readonly RepoSummary[],
  families: readonly Family[],
  titleOf: TeamTitleOf = keyAsTitle,
): SpaceCrumb[] {
  const all: SpaceCrumb = { label: 'All repositories', space: { kind: 'all' } }
  const teamsOf = (key: string) => repos.find((r) => repoKey(r.repo) === key)?.teams ?? []
  if (space.kind === 'all') return [all]
  if (space.kind === 'team') return [all, ...teamCrumb(space.team, titleOf)]
  if (space.kind === 'path')
    return [all, ...folderCrumbs(space.forge, space.folder), { label: space.folder, space }]
  if (space.kind === 'family') {
    const family = families.find((f) => f.id === space.family)
    const team = family?.members.map(teamsOf).find((teams) => teams.length)?.[0]
    return [all, ...teamCrumb(team, titleOf), ...(family ? [familyCrumb(family)] : [])]
  }
  const key = repoKey(space.repo)
  const family = families.find((f) => f.members.includes(key))
  return [
    all,
    ...teamCrumb(teamsOf(key)[0], titleOf),
    ...(family ? [familyCrumb(family)] : []),
    { label: space.repo.path, space },
  ]
}

/** The Guide, Notes and Learnings totals of a space; zeros when the counts leave it out. */
export const spaceCounts = (counts: KnowledgeCounts | undefined, space: Space) =>
  counts?.spaces[spaceKey(space)] ?? { guide: 0, notes: 0, learnings: 0 }

/** How many of `items` a folded list shows, and how many hide behind "N more". */
export function foldList<T>(
  items: readonly T[],
  limit: number,
  open: boolean,
): { shown: readonly T[]; more: number } {
  if (open || items.length <= limit + 1) return { shown: items, more: 0 }
  return { shown: items.slice(0, limit), more: items.length - limit }
}

/**
 * The display slots of a section's layers: the chain's layers in order, with an empty slot for
 * this repository's own rules (right after the rules files) and for generated text when the
 * section is generated and the chain has none, so both stay editable.
 */
export function layerSlots(
  layers: readonly GuideChainLayer[],
  options: { generated: boolean },
): ({ layer: GuideChainLayer } | { empty: 'repo' | 'generated' })[] {
  const slots: ({ layer: GuideChainLayer } | { empty: 'repo' | 'generated' })[] = layers.map(
    (layer) => ({ layer }),
  )
  if (!layers.some((layer) => layer.kind === 'repo'))
    slots.splice(layers[0]?.kind === 'repo-file' ? 1 : 0, 0, { empty: 'repo' })
  if (options.generated && !layers.some((layer) => layer.kind === 'generated')) {
    const notes = slots.findIndex((slot) => 'layer' in slot && slot.layer.kind === 'notes')
    slots.splice(notes < 0 ? slots.length : notes, 0, { empty: 'generated' })
  }
  return slots
}

/**
 * A line diff of two texts as one hunk (longest common subsequence), for the diff views of
 * `lib/diff.ts`. Equal texts give only context lines.
 */
export function lineDiff(before: string, after: string): DiffHunk {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i]! })
      i++
      j++
    } else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      lines.push({ kind: 'remove', text: a[i]! })
      i++
    } else {
      lines.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  return { oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length, lines }
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
