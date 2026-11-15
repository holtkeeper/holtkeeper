import {
  type RepoTarget,
  type Scope,
  folderPattern,
  hasWildcard,
  isExactPattern,
  pathAncestors,
  patternWithin,
  scopeCoversRepo,
  scopeSpecificity,
  sharedShape,
  splitPattern,
} from '@holtkeeper/access'
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgeMatch,
  KnowledgePackage,
} from '@holtkeeper/store'

import type { ProposalInput } from './propose.ts'
import { matchHolds, matchWithin } from './select.ts'
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

/**
 * Where a placement puts its entry: the repository, its family (`match.families`), a path shape
 * (`acme/*\/web`), a folder (`acme/round/**`), an owner team, or a library's home repository.
 */
export type PlacementLevel = 'repo' | 'family' | 'shape' | 'folder' | 'team' | 'library'

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
      /** An existing entry that already applies to the repository and says the same. */
      entryId: string
      /** Links to add to that entry (`mergeEvidence`). */
      evidence: KnowledgeLink[]
      matches: PlacementMatch[]
      why: string
    }

/**
 * How placement sees the fleet around a repository: the owner teams and the family of any fleet
 * repository. Without `familyOf` no repository has a family.
 */
export interface Neighbourhood {
  /** Owner teams of a fleet repository (`resolveRepo(config, repo).teams`). */
  teamsOf: (repo: RepoId) => string[]
  /** The family id of a fleet repository, when it belongs to one. */
  familyOf?: (repo: RepoId) => string | undefined
}

/** What `placeLessons` decides over. */
export interface PlacementInput extends Neighbourhood {
  /** The repository the lessons are about, with its owner teams. */
  repo: RepoTarget
  lessons: readonly LessonDraft[]
  /**
   * The knowledge base as it is now. Proposed and accepted entries are matched; rejected ones only
   * keep a rejected promotion from being proposed again.
   */
  entries: readonly KnowledgeEntry[]
  /** The fleet repository that owns a library subject, when one does. */
  libraryHome?: (subject: string) => RepoId | undefined
  /** Whether lessons may be placed above the repository. */
  promote: boolean
}

/** Least folder depth a folder promotion may target: `acme/round`, never `acme`. */
export const FOLDER_DEPTH = 2

const keyOf = (repo: RepoId) => `${repo.forge}:${repo.path}`

const segments = (path: string) => path.split('/').filter((segment) => segment !== '')

/** A pattern with its forge: bare patterns get `forge`. */
const qualify = (pattern: string, forge: string) =>
  splitPattern(pattern).forge === undefined ? `${forge}:${pattern}` : pattern

/** The repositories a scope names by exact path; bare paths get `forge`. */
export function exactRepos(scope: Scope, forge: string): RepoId[] {
  return (scope.repos ?? []).flatMap((pattern) => {
    const split = splitPattern(pattern)
    return hasWildcard(split.glob) ? [] : [{ forge: split.forge ?? forge, path: split.glob }]
  })
}

/** Whether `scope` names the repository by its exact path (`forge:path` or the bare path). */
export const scopeNamesRepo = (scope: Scope, repo: RepoId): boolean =>
  (scope.repos ?? []).some((pattern) => pattern === keyOf(repo) || pattern === repo.path)

/**
 * Every owner team an entry reaches: the teams its scope lists and the owner teams of the
 * repositories it names exactly. Globs reach no team (their repositories are not listed here).
 */
export function entryTeams(
  entry: Pick<KnowledgeEntry, 'scope'>,
  teamsOf: (repo: RepoId) => string[],
  forge: string,
): string[] {
  const teams = new Set(entry.scope.teams ?? [])
  for (const member of exactRepos(entry.scope, forge))
    for (const team of teamsOf(member)) teams.add(team)
  return [...teams].toSorted()
}

/**
 * Whether `entry` concerns the repository's team ("same team" = a shared owner team): its scope
 * covers the repository, or it reaches one of the repository's owner teams (`entryTeams`).
 */
export function reachesRepoTeams(
  entry: Pick<KnowledgeEntry, 'scope'>,
  repo: RepoTarget,
  teamsOf: (repo: RepoId) => string[],
): boolean {
  if (scopeCoversRepo(entry.scope, repo)) return true
  return entryTeams(entry, teamsOf, repo.forge).some((team) => repo.teams.includes(team))
}

/** How many leading folders the literal part of `glob` shares with the folders of `path`. */
function sharedFolderDepth(glob: string, path: string, exact: boolean): number {
  const literal: string[] = []
  for (const segment of segments(glob)) {
    if (hasWildcard(segment)) break
    literal.push(segment)
  }
  const pattern = exact ? literal.slice(0, -1) : literal
  const folders = segments(path).slice(0, -1)
  let depth = 0
  while (depth < pattern.length && depth < folders.length && pattern[depth] === folders[depth])
    depth++
  return depth
}

/**
 * Whether `entry` lies in the repository's neighbourhood, where lessons about the repository are
 * compared: it concerns the repository's owner teams (`reachesRepoTeams`), it is about the
 * repository's family (its `match.families` or the families of the repositories it names), or a
 * path pattern of it shares a folder at least `FOLDER_DEPTH` deep with the repository.
 */
export function nearRepo(
  entry: Pick<KnowledgeEntry, 'scope' | 'match'>,
  repo: RepoTarget,
  around: Neighbourhood,
): boolean {
  if (reachesRepoTeams(entry, repo, around.teamsOf)) return true
  const family = around.familyOf?.(repo)
  if (family !== undefined) {
    if (entry.match?.families?.includes(family)) return true
    if (exactRepos(entry.scope, repo.forge).some((member) => around.familyOf?.(member) === family))
      return true
  }
  return (entry.scope.repos ?? []).some((pattern) => {
    const split = splitPattern(pattern)
    if (split.forge !== undefined && split.forge !== repo.forge) return false
    return sharedFolderDepth(split.glob, repo.path, !hasWildcard(split.glob)) >= FOLDER_DEPTH
  })
}

/**
 * Proposed and accepted entries in the repository's neighbourhood (`nearRepo`), without `all`
 * scopes: what a lesson about the repository can be compared with.
 */
export function entriesNearRepo(
  entries: readonly KnowledgeEntry[],
  repo: RepoTarget,
  around: Neighbourhood,
): KnowledgeEntry[] {
  return entries.filter(
    (entry) =>
      (entry.status === 'proposed' || entry.status === 'accepted') &&
      !entry.scope.all &&
      nearRepo(entry, repo, around),
  )
}

/** Whether the pattern is a folder and everything under it (`acme/round/**`). */
const isFolderPattern = (pattern: string) => {
  const { glob } = splitPattern(pattern)
  return glob.endsWith('/**') && !hasWildcard(glob.slice(0, -3))
}

/**
 * A scope (and match) in words for logs and reports: `team widgets`, `folder work:acme/round/**`,
 * `repos work:acme/*\/web`, `repo work:acme/kit`, followed by `family f-web` and
 * `files src/**` when a match narrows it.
 */
export function describeScope(scope: Scope, match?: KnowledgeMatch): string {
  const parts = scope.all
    ? ['everything']
    : [
        ...(scope.teams ?? []).map((team) => `team ${team}`),
        ...(scope.repos ?? []).map((pattern) =>
          isExactPattern(pattern)
            ? `repo ${pattern}`
            : isFolderPattern(pattern)
              ? `folder ${pattern}`
              : `repos ${pattern}`,
        ),
      ]
  const narrowing = [
    ...(match?.families?.length ? [`family ${match.families.join(', ')}`] : []),
    ...(match?.files?.length ? [`files ${match.files.join(', ')}`] : []),
  ]
  return [parts.join(', ') || 'nothing', ...narrowing].join(' · ')
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
    scope: describeScope(entry.scope, entry.match),
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

/** Where a promotion goes: the scope, a family narrowing, and the key a rejection is matched by. */
interface Target {
  level: Exclude<PlacementLevel, 'repo' | 'library'>
  scope: Scope
  family?: string
  /** For team, shape and folder targets: the team key or the pattern. */
  key?: string
  reason: string
}

const targetMatch = (target: Target): KnowledgeMatch | undefined =>
  target.family === undefined ? undefined : { families: [target.family] }

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item))

/** Whether every repository `pattern` (qualified) names lies in the target's scope. */
function patternInside(pattern: string, scope: Scope, teamsOf: (repo: RepoId) => string[]) {
  if ((scope.repos ?? []).some((outer) => patternWithin(pattern, outer))) return true
  if (!isExactPattern(pattern) || !scope.teams?.length) return false
  const split = splitPattern(pattern)
  const owners = teamsOf({ forge: split.forge ?? '', path: split.glob })
  return owners.some((team) => scope.teams?.includes(team))
}

/**
 * Whether `entry` applies nowhere the target does not, and is not the target itself: its teams are
 * the target's, its patterns lie within the target's patterns (or name repositories of the
 * target's teams), and its match is within the target's — for a family target, an entry without a
 * family match qualifies when it names only repositories of that family. Such an entry is what a
 * promotion to the target generalises. Globs never lie within a team: their repositories are
 * unknown here.
 */
function narrowerThan(
  entry: KnowledgeEntry,
  target: Target,
  around: Neighbourhood,
  forge: string,
): boolean {
  const { scope } = entry
  if (scope.all) return false
  const teams = scope.teams ?? []
  const patterns = (scope.repos ?? []).map((pattern) => qualify(pattern, forge))
  if (!teams.length && !patterns.length) return false
  const inside =
    teams.every((team) => target.scope.teams?.includes(team)) &&
    patterns.every((pattern) => patternInside(pattern, target.scope, around.teamsOf))
  if (!inside) return false
  const match = targetMatch(target)
  const familyOnlyByMembers =
    target.family !== undefined &&
    !entry.match?.families?.length &&
    !teams.length &&
    patterns.every(isExactPattern) &&
    exactRepos(scope, forge).every((member) => around.familyOf?.(member) === target.family)
  if (!matchWithin(entry.match, match) && !familyOnlyByMembers) return false
  const same =
    sameList(teams, target.scope.teams ?? []) &&
    sameList(
      patterns,
      (target.scope.repos ?? []).map((pattern) => qualify(pattern, forge)),
    ) &&
    matchWithin(match, entry.match)
  return !same
}

/** Whether a rejected entry stands for the same promotion as `target`. */
function sameTarget(entry: KnowledgeEntry, target: Target, forge: string): boolean {
  if (target.family !== undefined) return entry.match?.families?.includes(target.family) ?? false
  if (entry.match?.families?.length || target.key === undefined) return false
  if (target.level === 'team') return entry.scope.teams?.includes(target.key) ?? false
  return (entry.scope.repos ?? []).some((pattern) => qualify(pattern, forge) === target.key)
}

/** Whether every candidate's scope lies within `scope` (path patterns only). */
const allWithin = (items: readonly Ranked[], scope: Scope, around: Neighbourhood, forge: string) =>
  items.every(
    ({ entry }) =>
      !entry.scope.all &&
      !entry.scope.teams?.length &&
      (entry.scope.repos ?? []).every((pattern) =>
        patternInside(qualify(pattern, forge), scope, around.teamsOf),
      ),
  )

/** The deepest folder of the repository, at least `FOLDER_DEPTH` deep, holding every match. */
function folderFor(repo: RepoTarget, items: readonly Ranked[], around: Neighbourhood) {
  for (const folder of pathAncestors(repo.path)) {
    if (segments(folder).length < FOLDER_DEPTH) break
    const pattern = folderPattern(folder, repo.forge)
    if (allWithin(items, { repos: [pattern] }, around, repo.forge)) return { folder, pattern }
  }
  return undefined
}

/**
 * The shape of the repository and the repositories the matches name, when they differ in one
 * segment that is not the last (`acme/*\/web`; a differing last segment is a folder) and every
 * match lies within it.
 */
function shapeFor(repo: RepoTarget, items: readonly Ranked[], around: Neighbourhood) {
  const paths = [
    repo.path,
    ...items.flatMap(({ entry }) =>
      exactRepos(entry.scope, repo.forge)
        .filter((member) => member.forge === repo.forge)
        .map((member) => member.path),
    ),
  ]
  const shape = sharedShape(paths)
  if (shape === undefined || segments(shape).at(-1) === '*') return undefined
  const pattern = `${repo.forge}:${shape}`
  return allWithin(items, { repos: [pattern] }, around, repo.forge) ? pattern : undefined
}

interface Ranked {
  entry: KnowledgeEntry
  match: PlacementMatch
  /** Owner teams the entry reaches (`entryTeams`). */
  teams: string[]
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

/** Whether every match is about the family: narrowed to it alone, or naming only its repositories. */
function inFamily(item: Ranked, family: string, around: Neighbourhood, forge: string): boolean {
  const families = item.entry.match?.families ?? []
  if (families.length) return families.every((id) => id === family)
  const { scope } = item.entry
  if (scope.all || scope.teams?.length || !scope.repos?.length) return false
  if (!scope.repos.every((pattern) => isExactPattern(pattern))) return false
  return exactRepos(scope, forge).every((member) => around.familyOf?.(member) === family)
}

/**
 * The scope of a family promotion: the narrowest description holding the repository and every
 * match — the deepest shared folder at least `FOLDER_DEPTH` deep, else their shape, else the owner
 * teams of the repository and of the matches, else the repositories themselves.
 */
function familyScope(repo: RepoTarget, items: readonly Ranked[], around: Neighbourhood): Scope {
  const folder = folderFor(repo, items, around)
  if (folder) return { repos: [folder.pattern] }
  const shape = shapeFor(repo, items, around)
  if (shape) return { repos: [shape] }
  const teams = [...new Set([...repo.teams, ...items.flatMap((item) => item.teams)])]
  if (teams.length) return { teams }
  const patterns = new Set([keyOf(repo)])
  for (const { entry } of items)
    for (const pattern of entry.scope.repos ?? []) patterns.add(qualify(pattern, repo.forge))
  return { repos: [...patterns] }
}

/**
 * The owner team of the repository the matches point at: the one reached by the best-ranked match
 * (ties: more matches, then the repository's team order). `undefined` when no match reaches one.
 */
function teamFor(repo: RepoTarget, ranked: readonly Ranked[]) {
  const options = repo.teams
    .map((team, order) => {
      const reached = ranked.filter((item) => item.teams.includes(team))
      return { team, order, reached, first: reached[0] ? ranked.indexOf(reached[0]) : Infinity }
    })
    .filter((option) => option.reached.length)
    .toSorted(
      (a, b) => a.first - b.first || b.reached.length - a.reached.length || a.order - b.order,
    )
  return options[0]
}

const matchWords = (match: PlacementMatch) =>
  `kb:${match.entryId.slice(0, 8)} (${match.scope}${match.related ? ', linked' : `, overlap ${match.overlap}`})`

/**
 * The scope agreement of starter knowledge: where each lesson about a repository goes. Pure and
 * deterministic; the caller writes the outcome through `proposeEntry` (create) or
 * `mergeEvidence` (covered), never auto-accepting a promotion.
 *
 * 1. A `library` lesson gets the library as `subject`, visibility `shared` and the package. When
 *    the library's home is another fleet repository, it is scoped to that repository (`library`).
 * 2. A lesson matches proposed and accepted entries in the repository's neighbourhood
 *    (`entriesNearRepo`: its owner teams, its family, folders at least `FOLDER_DEPTH` deep; never
 *    `all` scopes) that it names in `related`, or whose title overlaps by `TITLE_MATCH`, or whose
 *    title and text overlap by `TEXT_MATCH`. An entry another such entry supersedes is no
 *    candidate: its text and id count for the entry that replaces it. Matches rank linked first,
 *    then by overlap, then narrower scope, then newest.
 * 3. When any match already applies to the repository (scope covers it, its family match holds),
 *    the lesson is `covered`: its evidence is merged into the best such entry. This holds for
 *    repository-specific lessons and with `promote` off.
 * 4. Otherwise the scope is the repository (`repo`); a lesson that is `repoSpecific` and any lesson
 *    when `promote` is off stay there.
 * 5. Team `process` goes to the owner team the best match reaches, else the repository's first
 *    owner team (`team`), with or without matches; a repository without owner teams keeps it.
 * 6. Other lessons need matches, and take the narrowest description holding the repository and all
 *    of them: (a) `family` when the repository and every match belong to one family —
 *    `match.families: [id]`, scoped by `familyScope` (shared folder, else shape, else owner teams);
 *    (b) `shape` when the repositories differ in one inner segment (`work:acme/*\/web`); (c)
 *    `folder`, the deepest folder at least `FOLDER_DEPTH` deep holding them
 *    (`work:acme/round/**`); (d) `team`, the owner team the best match reaches. Without any it
 *    stays at the repository.
 * 7. A promotion takes the lesson's `general` wording when given, carries the lesson's evidence and
 *    that of every match narrower than the target (`generalises`), and supersedes the best of them.
 *    When a rejected entry for the same target (the same family, team or pattern) supersedes one of
 *    those matches or matches the lesson, the promotion was refused before and the lesson stays at
 *    the repository.
 */
export function placeLessons(input: PlacementInput): Placement[] {
  const { repo } = input
  const around: Neighbourhood = {
    teamsOf: input.teamsOf,
    ...(input.familyOf && { familyOf: input.familyOf }),
  }
  const here = keyOf(repo)
  const family = input.familyOf?.(repo)
  const candidates = liveCandidates(entriesNearRepo(input.entries, repo, around))
  const rejected = input.entries.filter((entry) => entry.status === 'rejected')
  const appliesHere = (entry: KnowledgeEntry) =>
    scopeCoversRepo(entry.scope, repo) &&
    matchHolds(entry.match, family === undefined ? {} : { family })

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
        return match ? [{ entry, match, teams: entryTeams(entry, input.teamsOf, repo.forge) }] : []
      }),
    )
    const matches = ranked.map((item) => item.match)
    const covering = ranked.find((item) => appliesHere(item.entry))
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

    let target: Target | undefined
    let inTarget: readonly Ranked[] = ranked
    if (lesson.level === 'process') {
      const chosen = teamFor(repo, ranked)
      const team = chosen?.team ?? repo.teams[0]
      if (team === undefined) return stay('team process, but the repository has no owner team')
      inTarget = chosen?.reached ?? []
      target = { level: 'team', scope: { teams: [team] }, key: team, reason: 'team process' }
    } else {
      if (!ranked.length) return stay('no matching entry around it', matches)
      const shape = shapeFor(repo, ranked, around)
      const folder = folderFor(repo, ranked, around)
      const chosen = teamFor(repo, ranked)
      if (
        family !== undefined &&
        ranked.every((item) => inFamily(item, family, around, repo.forge))
      )
        target = {
          level: 'family',
          scope: familyScope(repo, ranked, around),
          family,
          reason: `the same family ${family} has it`,
        }
      else if (shape)
        target = {
          level: 'shape',
          scope: { repos: [shape] },
          key: shape,
          reason: `siblings of the shape ${splitPattern(shape).glob} have it`,
        }
      else if (folder)
        target = {
          level: 'folder',
          scope: { repos: [folder.pattern] },
          key: folder.pattern,
          reason: `a sibling in ${folder.folder} has it`,
        }
      else if (chosen) {
        inTarget = chosen.reached
        target = {
          level: 'team',
          scope: { teams: [chosen.team] },
          key: chosen.team,
          reason: `shares owner team ${chosen.team} with it`,
        }
      } else return stay('no folder, shape, family or owner team holds it and its matches', matches)
    }

    const narrower = inTarget.filter((item) => narrowerThan(item.entry, target, around, repo.forge))
    const generalises = narrower.map((item) => item.entry.id)
    const match = targetMatch(target)
    const where = describeScope(target.scope, match)
    const refused = rejected.find(
      (entry) =>
        sameTarget(entry, target, repo.forge) &&
        ((entry.supersedes !== undefined && generalises.includes(entry.supersedes)) ||
          matchOf(lesson, entry) !== undefined),
    )
    if (refused)
      return stay(
        `a promotion to ${where} was rejected (kb:${refused.id.slice(0, 8)}); kept at the repository`,
        matches,
      )

    const supersedes = generalises[0]
    const [top, ...rest] = inTarget
    const words = general(lesson)
    return {
      action: 'create',
      lesson,
      level: target.level,
      input: {
        ...base,
        title: words.title,
        body: words.body,
        scope: target.scope,
        ...(match && { match }),
        evidence: mergeLinks(lesson.evidence, ...narrower.map((item) => item.entry.evidence)),
        ...(supersedes && { supersedes }),
      },
      ...(supersedes && { supersedes }),
      ...(generalises.length && { generalises }),
      matches,
      why: [
        top ? `${target.reason}: matches ${matchWords(top.match)}` : target.reason,
        ...(rest.length ? [`also ${rest.map((item) => matchWords(item.match)).join(', ')}`] : []),
        ...(supersedes ? [`supersedes kb:${supersedes.slice(0, 8)}`] : []),
      ].join('; '),
    }
  })
}

/** Key in `Store.kv` marking that starter knowledge was built for the repository; never expires. */
export const bootstrapMarker = (repo: RepoId): string =>
  `knowledge:bootstrap:${repo.forge}:${repo.path}`
