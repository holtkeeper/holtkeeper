import {
  type GroupMatch,
  type RepoTarget,
  type Scope,
  groupLineage,
  isSubgroup,
  rootGroup,
  scopeCoversRepo,
  scopeSpecificity,
} from '@holtkeeper/access'
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
} from '@holtkeeper/store'

import type { ProposalInput } from './propose.ts'
import { textOverlap } from './text.ts'

/** A repository by forge id and path. */
export interface RepoId {
  forge: string
  path: string
}

/** Title word overlap (Jaccard) from which a lesson matches an existing entry. */
export const TITLE_MATCH = 0.5

/** Title-and-text word overlap (Jaccard) from which a lesson matches an existing entry. */
export const TEXT_MATCH = 0.35

/**
 * What a lesson is about: `repo` code of the repository, `process` how the team works (merge
 * requests, reviews, releases, branches), `library` how to use the library named in `library`.
 */
export type LessonLevel = 'repo' | 'process' | 'library'

/** One lesson learned about a repository, before it is placed and proposed. */
export interface LessonDraft {
  title: string
  body: string
  kind: KnowledgeKind
  topics?: string[]
  evidence: KnowledgeLink[]
  level: LessonLevel
  /** For `library` lessons: the library's subject, `Go:<module>` or `npm:<name>`. */
  library?: string
  /** It only makes sense in this repository (its own paths or commands): never promoted. */
  repoSpecific: boolean
  /** Ids of existing entries the lesson repeats for other repositories. */
  related?: string[]
  /** Wording that holds for every repository the lesson and its matches cover. */
  general?: { title: string; body: string }
}

/** Where a placement puts its entry. */
export type PlacementLevel = 'repo' | 'subgroup' | 'group' | 'library'

/** An existing entry a lesson matched. */
export interface PlacementMatch {
  entryId: string
  title: string
  /** `describeScope` of the entry. */
  scope: string
  /** The higher of the title and the full-text overlap. */
  overlap: number
  /** The lesson named the entry in `related`. */
  related: boolean
}

/** The decision for one lesson. */
export type Placement =
  | {
      action: 'create'
      lesson: LessonDraft
      level: PlacementLevel
      /** What to hand to `proposeEntry`; never auto-accept a promotion. */
      input: ProposalInput
      /** The narrower entry the new one replaces, also in `input.supersedes`. */
      supersedes?: string
      /**
       * Every narrower match a promotion generalises, `supersedes` first: none of them may count as
       * the new entry's duplicate (`ProposeEntryOptions.notDuplicates`).
       */
      generalises?: string[]
      matches: PlacementMatch[]
      why: string
    }
  | {
      action: 'covered'
      lesson: LessonDraft
      /** An existing entry whose scope already covers the repository and says the same. */
      entryId: string
      /** Links to add to that entry (`mergeEvidence`). */
      evidence: KnowledgeLink[]
      matches: PlacementMatch[]
      why: string
    }

/** What `placeLessons` decides over. */
export interface PlacementInput {
  /** The repository the lessons are about, with every group it belongs to (subgroups and roots). */
  repo: RepoTarget
  lessons: readonly LessonDraft[]
  /**
   * The knowledge base as it is now. Proposed and accepted entries are matched; rejected ones only
   * keep a rejected promotion from being proposed again.
   */
  entries: readonly KnowledgeEntry[]
  /** Groups of another repository of the fleet, subgroups and roots. */
  groupsOf: (repo: RepoId) => string[]
  /** The fleet repository that owns a library subject, when one does. */
  libraryHome?: (subject: string) => RepoId | undefined
  /** Whether lessons may be placed above the repository. */
  promote: boolean
}

const keyOf = (repo: RepoId) => `${repo.forge}:${repo.path}`

const hasWildcard = (glob: string) => /[*?[\]{}]/.test(glob)

const namesOf = (match: GroupMatch) => (typeof match === 'string' ? [match] : match)

/** The repositories a scope names by exact path; bare paths get `forge`. */
export function exactRepos(scope: Scope, forge: string): RepoId[] {
  return (scope.repos ?? []).flatMap((pattern) => {
    const separator = pattern.indexOf(':')
    const id =
      separator > 0
        ? { forge: pattern.slice(0, separator), path: pattern.slice(separator + 1) }
        : { forge, path: pattern }
    return hasWildcard(id.path) ? [] : [id]
  })
}

/** Whether `scope` names the repository by its exact path (`forge:path` or the bare path). */
export const scopeNamesRepo = (scope: Scope, repo: RepoId): boolean =>
  (scope.repos ?? []).some((pattern) => pattern === keyOf(repo) || pattern === repo.path)

/**
 * Every group an entry reaches: the groups its scope lists with their parents, and the groups of
 * the repositories it names exactly.
 */
export function entryGroups(
  entry: Pick<KnowledgeEntry, 'scope'>,
  groupsOf: (repo: RepoId) => string[],
  forge: string,
): string[] {
  const groups = new Set<string>()
  for (const match of entry.scope.groups ?? [])
    for (const name of namesOf(match)) for (const group of groupLineage(name)) groups.add(group)
  for (const member of exactRepos(entry.scope, forge))
    for (const group of groupsOf(member)) for (const up of groupLineage(group)) groups.add(up)
  return [...groups].toSorted()
}

/**
 * Whether `entry` concerns the repository's team: its scope covers the repository, or it reaches
 * one of the repository's root groups (`entryGroups`).
 */
export function reachesRepoRoots(
  entry: Pick<KnowledgeEntry, 'scope'>,
  repo: RepoTarget,
  groupsOf: (repo: RepoId) => string[],
): boolean {
  if (scopeCoversRepo(entry.scope, repo)) return true
  const roots = new Set(repo.groups.map(rootGroup))
  return entryGroups(entry, groupsOf, repo.forge).some((group) => roots.has(rootGroup(group)))
}

/**
 * Proposed and accepted entries that cover the repository or share a root group with it, without
 * `all` scopes: what a lesson about the repository can be compared with.
 */
export function entriesInRoots(
  entries: readonly KnowledgeEntry[],
  repo: RepoTarget,
  groupsOf: (repo: RepoId) => string[],
): KnowledgeEntry[] {
  return entries.filter(
    (entry) =>
      (entry.status === 'proposed' || entry.status === 'accepted') &&
      !entry.scope.all &&
      reachesRepoRoots(entry, repo, groupsOf),
  )
}

/** A scope in words for logs and reports: `group shapes`, `subgroup shapes.round`, `repo work:a/b`. */
export function describeScope(scope: Scope): string {
  if (scope.all) return 'everything'
  const parts = [
    ...(scope.groups ?? []).map((match) => {
      const names = namesOf(match)
      const label = names.join('+')
      return names.length === 1 && isSubgroup(label) ? `subgroup ${label}` : `group ${label}`
    }),
    ...(scope.repos ?? []).map((pattern) => `repo ${pattern}`),
  ]
  return parts.join(', ') || 'nothing'
}

const round = (value: number) => Math.round(value * 100) / 100

function matchOf(
  lesson: LessonDraft,
  entry: KnowledgeEntry,
  replaced: readonly KnowledgeEntry[] = [],
): PlacementMatch | undefined {
  const versions = [entry, ...replaced]
  const related = versions.some((version) => lesson.related?.includes(version.id) ?? false)
  const texts = [lesson, ...(lesson.general ? [lesson.general] : [])]
  let title = 0
  let text = 0
  for (const candidate of texts)
    for (const version of versions) {
      title = Math.max(title, textOverlap(candidate.title, version.title))
      text = Math.max(
        text,
        textOverlap(`${candidate.title}\n${candidate.body}`, `${version.title}\n${version.body}`),
      )
    }
  if (!related && title < TITLE_MATCH && text < TEXT_MATCH) return undefined
  return {
    entryId: entry.id,
    title: entry.title,
    scope: describeScope(entry.scope),
    overlap: round(Math.max(title, text)),
    related,
  }
}

function mergeLinks(...lists: (readonly KnowledgeLink[])[]): KnowledgeLink[] {
  const byUrl = new Map<string, KnowledgeLink>()
  for (const link of lists.flat()) if (!byUrl.has(link.url)) byUrl.set(link.url, link)
  return [...byUrl.values()]
}

const general = (lesson: LessonDraft) =>
  lesson.general ?? { title: lesson.title, body: lesson.body }

function packageOf(subject: string): KnowledgePackage | undefined {
  const separator = subject.indexOf(':')
  if (separator < 1) return undefined
  const ecosystem = subject.slice(0, separator).toLowerCase()
  const name = subject.slice(separator + 1)
  return name ? { ecosystem, name } : undefined
}

/**
 * Whether `entry` is narrower than the group `target`: every repository it names exactly is in
 * `target`, and every group it lists lies strictly below `target`. Such an entry is what a
 * promotion to `target` supersedes.
 */
function narrowerThan(
  entry: KnowledgeEntry,
  target: string,
  groupsOf: (repo: RepoId) => string[],
  forge: string,
): boolean {
  const { scope } = entry
  if (scope.all) return false
  const repos = scope.repos ?? []
  const groups = scope.groups ?? []
  if (!repos.length && !groups.length) return false
  const exact = exactRepos(scope, forge)
  if (exact.length !== repos.length) return false
  const reposInside = exact.every((member) =>
    groupsOf(member).some((group) => groupLineage(group).includes(target)),
  )
  const groupsBelow = groups.every((match) =>
    namesOf(match).some((name) => name !== target && groupLineage(name).includes(target)),
  )
  return reposInside && groupsBelow
}

interface Ranked {
  entry: KnowledgeEntry
  match: PlacementMatch
  groups: string[]
}

const rankMatches = (ranked: Ranked[]) =>
  ranked.toSorted(
    (a, b) =>
      Number(b.match.related) - Number(a.match.related) ||
      b.match.overlap - a.match.overlap ||
      scopeSpecificity(b.entry.scope) - scopeSpecificity(a.entry.scope) ||
      b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
      a.entry.id.localeCompare(b.entry.id),
  )

const subgroupsUnder = (groups: readonly string[], root: string) =>
  groups.filter((group) => isSubgroup(group) && rootGroup(group) === root)

/**
 * The live candidates, each with the entries it replaces through `supersedes` (transitively): an
 * entry another candidate supersedes is no candidate itself, its text matches for its replacement.
 */
function liveCandidates(
  candidates: readonly KnowledgeEntry[],
): { entry: KnowledgeEntry; replaced: KnowledgeEntry[] }[] {
  const byId = new Map(candidates.map((entry) => [entry.id, entry]))
  const superseded = new Set(candidates.flatMap((entry) => entry.supersedes ?? []))
  return candidates
    .filter((entry) => !superseded.has(entry.id))
    .map((entry) => {
      const replaced: KnowledgeEntry[] = []
      const seen = new Set([entry.id])
      let next = entry.supersedes
      while (next && !seen.has(next)) {
        seen.add(next)
        const older = byId.get(next)
        if (!older) break
        replaced.push(older)
        next = older.supersedes
      }
      return { entry, replaced }
    })
}

const scopeNamesGroup = (scope: Scope, group: string) =>
  (scope.groups ?? []).some((match) => namesOf(match).includes(group))

const matchWords = (match: PlacementMatch) =>
  `kb:${match.entryId.slice(0, 8)} (${match.scope}${match.related ? ', linked' : `, overlap ${match.overlap}`})`

/**
 * The scope agreement of starter knowledge: where each lesson about a repository goes. Pure and
 * deterministic; the caller writes the outcome through `proposeEntry` (create) or
 * `mergeEvidence` (covered), never auto-accepting a promotion.
 *
 * 1. A `library` lesson gets the library as `subject`, visibility `shared` and the package. When
 *    the library's home is another fleet repository, it is scoped to that repository (`library`).
 * 2. A lesson matches proposed and accepted entries that cover the repository or lie in its root
 *    groups (never `all` scopes) that it names in `related`, or whose title overlaps by
 *    `TITLE_MATCH`, or whose title and text overlap by `TEXT_MATCH`. An entry another such entry
 *    supersedes is no candidate: its text and id count for the entry that replaces it. Matches rank
 *    linked first, then by overlap, then narrower scope, then newest.
 * 3. When any match already covers the repository, the lesson is `covered`: its evidence is merged
 *    into the best such entry. This holds for repository-specific lessons and with `promote` off.
 * 4. Otherwise the scope is the repository (`repo`); a lesson that is `repoSpecific`, any lesson
 *    when `promote` is off, and a lesson without matches stay there.
 * 5. The root group with the best match decides. The lesson goes to that root group (`group`) when
 *    it is team `process`, or when the repository and all its matches in that root share no
 *    subgroup (the matches span two or more subgroups, or lie outside the repository's); to the
 *    shared subgroup (`subgroup`) otherwise.
 * 6. A promotion takes the lesson's `general` wording when given, carries the lesson's evidence and
 *    that of every match narrower than the target (`generalises`), and supersedes the best of them.
 *    When a rejected entry scoped to the target supersedes one of those matches or matches the
 *    lesson, the promotion was refused before and the lesson stays at the repository.
 */
export function placeLessons(input: PlacementInput): Placement[] {
  const { repo, groupsOf } = input
  const here = keyOf(repo)
  const candidates = liveCandidates(entriesInRoots(input.entries, repo, groupsOf))
  const rejected = input.entries.filter((entry) => entry.status === 'rejected')
  const repoGroups = [...new Set(repo.groups.flatMap(groupLineage))]
  const roots = [...new Set(repoGroups.map(rootGroup))].toSorted()

  return input.lessons.map((lesson): Placement => {
    const library = lesson.level === 'library' ? lesson.library : undefined
    const pkg = library ? packageOf(library) : undefined
    const base: ProposalInput = {
      title: lesson.title,
      body: lesson.body,
      kind: lesson.kind,
      ...(lesson.topics?.length && { topics: lesson.topics }),
      evidence: lesson.evidence,
      scope: { repos: [here] },
      ...(library && { subject: library, visibility: 'shared' as const }),
      ...(pkg && { packages: [pkg] }),
    }
    if (library) {
      const home = input.libraryHome?.(library)
      if (home && keyOf(home) !== here)
        return {
          action: 'create',
          lesson,
          level: 'library',
          input: { ...base, scope: { repos: [keyOf(home)] } },
          matches: [],
          why: `how to use ${library}, whose home is ${keyOf(home)}`,
        }
    }
    const stay = (why: string, matches: PlacementMatch[] = []): Placement => ({
      action: 'create',
      lesson,
      level: 'repo',
      input: base,
      matches,
      why,
    })

    const ranked = rankMatches(
      candidates.flatMap(({ entry, replaced }) => {
        const match = matchOf(lesson, entry, replaced)
        return match ? [{ entry, match, groups: entryGroups(entry, groupsOf, repo.forge) }] : []
      }),
    )
    const matches = ranked.map((item) => item.match)
    const covering = ranked.find((item) => scopeCoversRepo(item.entry.scope, repo))
    if (covering)
      return {
        action: 'covered',
        lesson,
        entryId: covering.entry.id,
        evidence: lesson.evidence,
        matches,
        why: `already covered by ${matchWords(covering.match)}`,
      }
    if (!input.promote) return stay('promotion is off', matches)
    if (lesson.repoSpecific) return stay('specific to this repository', matches)

    const byRoot = roots
      .map((root) => {
        const inRoot = ranked.filter((item) =>
          item.groups.some((group) => rootGroup(group) === root),
        )
        return { root, inRoot, first: inRoot[0] ? ranked.indexOf(inRoot[0]) : Infinity }
      })
      .filter((option) => option.inRoot.length)
      .toSorted(
        (a, b) =>
          a.first - b.first || b.inRoot.length - a.inRoot.length || a.root.localeCompare(b.root),
      )
    const chosen = byRoot[0]
    const top = chosen?.inRoot[0]
    if (!chosen || !top) return stay('no matching entry in its groups', matches)

    const touched = new Set(
      chosen.inRoot.flatMap((item) => subgroupsUnder(item.groups, chosen.root)),
    )
    const shared = subgroupsUnder(repoGroups, chosen.root)
      .filter((group) => chosen.inRoot.every((item) => item.groups.includes(group)))
      .toSorted()
    let target: string
    let level: 'subgroup' | 'group'
    let reason: string
    if (lesson.level === 'process') {
      target = chosen.root
      level = 'group'
      reason = 'team process'
    } else if (shared[0]) {
      target = shared[0]
      level = 'subgroup'
      reason = `a sibling in ${shared[0]} has it`
    } else if (touched.size >= 2) {
      target = chosen.root
      level = 'group'
      reason = `spans subgroups ${[...touched].toSorted().join(', ')}`
    } else {
      target = chosen.root
      level = 'group'
      reason = `shares only group ${chosen.root} with it`
    }

    const narrower = chosen.inRoot.filter((item) =>
      narrowerThan(item.entry, target, groupsOf, repo.forge),
    )
    const generalises = narrower.map((item) => item.entry.id)
    const refused = rejected.find(
      (entry) =>
        scopeNamesGroup(entry.scope, target) &&
        ((entry.supersedes !== undefined && generalises.includes(entry.supersedes)) ||
          matchOf(lesson, entry) !== undefined),
    )
    if (refused)
      return stay(
        `a promotion to ${target} was rejected (kb:${refused.id.slice(0, 8)}); kept at the repository`,
        matches,
      )

    const supersedes = generalises[0]
    const others = chosen.inRoot.slice(1).map((item) => matchWords(item.match))
    const words = general(lesson)
    return {
      action: 'create',
      lesson,
      level,
      input: {
        ...base,
        title: words.title,
        body: words.body,
        scope: { groups: [target] },
        evidence: mergeLinks(lesson.evidence, ...narrower.map((item) => item.entry.evidence)),
        ...(supersedes && { supersedes }),
      },
      ...(supersedes && { supersedes }),
      ...(generalises.length && { generalises }),
      matches,
      why: [
        `${reason}: matches ${matchWords(top.match)}`,
        ...(others.length ? [`also ${others.join(', ')}`] : []),
        ...(supersedes ? [`supersedes kb:${supersedes.slice(0, 8)}`] : []),
      ].join('; '),
    }
  })
}

/** Key in `Store.kv` marking that starter knowledge was built for the repository; never expires. */
export const bootstrapMarker = (repo: RepoId): string =>
  `knowledge:bootstrap:${repo.forge}:${repo.path}`
