import { commonFolder, sharedShape } from '@holtkeeper/access/paths'
import type { Family } from '@holtkeeper/store'

/** What the suggester knows about one repository. */
export interface RepoSignals {
  /** `forge:path`. */
  repo: string
  /** Names of the packages the repository depends on directly; its own packages left out. */
  dependencies: readonly string[]
  /** Runtimes and package managers it uses, e.g. `node`, `pnpm`. */
  toolchain?: readonly string[]
}

/** Repositories that look alike enough to share rules; a person confirms before it is a family. */
export interface FamilySuggestion {
  /**
   * A proposed name plus the framework, unique among the suggestions of one run: the members' shared
   * shape when their paths differ in one folder segment only (`acme/*\/web`), else the last segment
   * of the deepest folder they share and the words their repository names share (`round/front`).
   */
  name: string
  /** `forge:path`, sorted. */
  members: string[]
  /** The lowest dependency similarity (Jaccard, 0–1) between any two members. */
  similarity: number
  framework?: string
  toolchain: string[]
  /** Dependencies every member has, sorted, at most ten. */
  shared: string[]
}

export interface SuggestFamiliesOptions {
  /** Lowest Jaccard similarity of direct dependency names between any two members. Default 0.6. */
  threshold?: number
  /** Fewest members of a suggestion. Default 2. */
  minSize?: number
  /** Repositories left out, e.g. those already in a family. */
  exclude?: Iterable<string>
}

/** Frameworks by the dependency that marks them, meta-frameworks before what they build on. */
const FRAMEWORKS: readonly [name: string, dependency: string][] = [
  ['next', 'next'],
  ['nuxt', 'nuxt'],
  ['sveltekit', '@sveltejs/kit'],
  ['remix', '@remix-run/react'],
  ['astro', 'astro'],
  ['angular', '@angular/core'],
  ['nest', '@nestjs/core'],
  ['react-native', 'react-native'],
  ['react', 'react'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['solid', 'solid-js'],
  ['preact', 'preact'],
  ['express', 'express'],
  ['fastify', 'fastify'],
]

/** The framework a dependency list marks, or `undefined` when none of the known ones. */
export function frameworkOf(dependencies: readonly string[]): string | undefined {
  const names = new Set(dependencies)
  return FRAMEWORKS.find(([, dependency]) => names.has(dependency))?.[0]
}

/** Jaccard similarity of two name sets: shared names over all names; 0 when both are empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 0
  let shared = 0
  for (const name of a) if (b.has(name)) shared++
  return shared / (a.size + b.size - shared)
}

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A repository's signals in the form similarity is computed on. */
interface Profile {
  repo: string
  deps: ReadonlySet<string>
  framework: string | undefined
  toolchain: string[]
  /** Framework and toolchain: only repositories with the same signature can be alike. */
  signature: string
}

const profileOf = (signal: RepoSignals): Profile => {
  const framework = frameworkOf(signal.dependencies)
  const toolchain = [...new Set(signal.toolchain ?? [])].toSorted(binary)
  return {
    repo: signal.repo,
    deps: new Set(signal.dependencies),
    framework,
    toolchain,
    signature: `${framework ?? ''}|${toolchain.join(',')}`,
  }
}

const profileSimilarity = (a: Profile, b: Profile): number =>
  a.signature === b.signature ? jaccard(a.deps, b.deps) : 0

const round = (value: number) => Math.round(value * 1000) / 1000

/**
 * How alike two repositories are, the measure families are suggested by: the Jaccard similarity of
 * their direct dependency names (0–1) when they have the same framework (`frameworkOf`) and the same
 * toolchain, else 0. Symmetric and deterministic; where the repositories sit plays no part.
 */
export const repoSimilarity = (a: RepoSignals, b: RepoSignals): number =>
  profileSimilarity(profileOf(a), profileOf(b))

const wordsOf = (segment: string): string[] => segment.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

function proposedName(members: readonly string[], framework: string | undefined): string {
  const paths = members.map((member) => member.slice(member.indexOf(':') + 1))
  const shape = sharedShape(paths)
  // A shape whose wildcard is the repository name itself says less than the shared words do.
  const base =
    (shape && !shape.endsWith('*') ? shape : undefined) ??
    ([commonFolder(paths)?.split('/').at(-1), sharedWords(paths).join('-')]
      .filter(Boolean)
      .join('/') ||
      framework ||
      'similar')
  return framework && base !== framework ? `${base} (${framework})` : base
}

/** The words every repository name (the last path segment) holds, in the first one's order. */
function sharedWords(paths: readonly string[]): string[] {
  const names = paths.map((path) => path.split('/').at(-1) ?? '')
  const sets = names.map((name) => new Set(wordsOf(name)))
  return wordsOf(names[0] ?? '').filter(
    (word, index, all) => all.indexOf(word) === index && sets.every((set) => set.has(word)),
  )
}

/**
 * Makes names that several suggestions share tell them apart: each gets the first of its shared
 * dependencies the others with that name lack, or a number when none is left.
 */
function distinctNames(suggestions: FamilySuggestion[]): FamilySuggestion[] {
  const byName = Map.groupBy(suggestions, (suggestion) => suggestion.name)
  return suggestions.map((suggestion) => {
    const twins = byName.get(suggestion.name) ?? []
    if (twins.length < 2) return suggestion
    const others = twins.filter((twin) => twin !== suggestion)
    const mark = suggestion.shared.find((dep) =>
      others.every((other) => !other.shared.includes(dep)),
    )
    return {
      ...suggestion,
      name: `${suggestion.name} · ${mark ?? twins.indexOf(suggestion) + 1}`,
    }
  })
}

/**
 * Proposes families: repositories with the same framework and toolchain whose direct dependency
 * names are similar (complete linkage: every two members reach `threshold`), wherever they sit in
 * the path tree. Repositories without dependencies and `exclude`d ones (a repository belongs to at
 * most one family) are never proposed. The result is deterministic: the same
 * signals in any order give the same suggestions, largest first.
 */
export function suggestFamilies(
  signals: readonly RepoSignals[],
  options: SuggestFamiliesOptions = {},
): FamilySuggestion[] {
  const threshold = options.threshold ?? 0.6
  const minSize = Math.max(2, options.minSize ?? 2)
  const excluded = new Set(options.exclude ?? [])
  const repos = signals
    .filter((signal) => signal.dependencies.length > 0 && !excluded.has(signal.repo))
    .map(profileOf)
    .toSorted((a, b) => binary(a.repo, b.repo))

  const bySignature = new Map<string, Profile[]>()
  for (const repo of repos)
    bySignature.set(repo.signature, [...(bySignature.get(repo.signature) ?? []), repo])

  const suggestions: FamilySuggestion[] = []
  for (const group of bySignature.values()) {
    if (group.length < minSize) continue
    const similarity = group.map((a) => group.map((b) => profileSimilarity(a, b)))
    let clusters = group.map((_, index) => [index])
    const linkage = (a: number[], b: number[]) =>
      Math.min(...a.flatMap((i) => b.map((j) => similarity[i]?.[j] ?? 0)))
    for (;;) {
      let best: { a: number; b: number; score: number } | undefined
      for (let a = 0; a < clusters.length; a++)
        for (let b = a + 1; b < clusters.length; b++) {
          const score = linkage(clusters[a] ?? [], clusters[b] ?? [])
          if (score >= threshold && (!best || score > best.score)) best = { a, b, score }
        }
      if (!best) break
      const { a, b } = best
      clusters = [
        ...clusters.filter((_, index) => index !== a && index !== b),
        [...(clusters[a] ?? []), ...(clusters[b] ?? [])].toSorted((x, y) => x - y),
      ]
    }
    for (const cluster of clusters) {
      if (cluster.length < minSize) continue
      const members = cluster.flatMap((index) => group[index] ?? [])
      const first = members[0]
      if (!first) continue
      const shared = [...first.deps]
        .filter((dep) => members.every((member) => member.deps.has(dep)))
        .toSorted(binary)
      const names = members.map((member) => member.repo)
      suggestions.push({
        name: proposedName(names, first.framework),
        members: names,
        similarity: round(linkage(cluster, cluster)),
        ...(first.framework && { framework: first.framework }),
        toolchain: first.toolchain,
        shared: shared.slice(0, 10),
      })
    }
  }
  return distinctNames(
    suggestions.toSorted(
      (a, b) =>
        b.members.length - a.members.length ||
        b.similarity - a.similarity ||
        binary(a.members[0] ?? '', b.members[0] ?? ''),
    ),
  )
}

/** Identity of a suggestion across runs: its members as a set, sorted and joined by `,`. */
export const suggestionKey = (members: readonly string[]): string =>
  [...new Set(members)].toSorted(binary).join(',')

/** The family `repo` (`forge:path`) belongs to, if any; a repository is in at most one. */
export const familyOf = (families: readonly Family[], repo: string): Family | undefined =>
  families.find((family) => family.members.includes(repo))

/** A repository alike enough to another one that its knowledge may help there. */
export interface RepoNeighbour {
  /** `forge:path`. */
  repo: string
  /** `repoSimilarity` to the repository asked about, rounded to three decimals. */
  similarity: number
}

export interface RepoNeighboursOptions {
  /** Most neighbours returned. Default 5. */
  limit?: number
  /** Lowest similarity of a neighbour (above 0 in any case). Default 0.5. */
  min?: number
  /**
   * Confirmed families: members of the repository's own family are left out, since they already
   * share the family's rules and knowledge.
   */
  families?: readonly Family[]
}

/**
 * The repositories most like `repo` (`forge:path`) among `signals`, by the similarity families are
 * suggested by (`repoSimilarity`): at least `min`, most alike first, then by path, at most
 * `limit`. The repository itself, members of its family and repositories without dependencies are
 * never neighbours; a repository missing from `signals` or without dependencies has none.
 * Deterministic: the same signals in any order give the same neighbours.
 */
export function repoNeighbours(
  signals: readonly RepoSignals[],
  repo: string,
  options: RepoNeighboursOptions = {},
): RepoNeighbour[] {
  const limit = options.limit ?? 5
  const min = options.min ?? 0.5
  const own = signals.find((signal) => signal.repo === repo)
  if (!own?.dependencies.length || limit <= 0) return []
  const profile = profileOf(own)
  const family = options.families ? familyOf(options.families, repo) : undefined
  const skip = new Set([repo, ...(family?.members ?? [])])
  const found = new Map<string, number>()
  for (const signal of signals) {
    if (skip.has(signal.repo) || !signal.dependencies.length) continue
    const similarity = round(profileSimilarity(profile, profileOf(signal)))
    // A repository listed twice counts with its best signals, whatever their order.
    if (similarity > 0 && similarity >= min)
      found.set(signal.repo, Math.max(similarity, found.get(signal.repo) ?? 0))
  }
  return [...found]
    .map(([neighbour, similarity]) => ({ repo: neighbour, similarity }))
    .toSorted((a, b) => b.similarity - a.similarity || binary(a.repo, b.repo))
    .slice(0, limit)
}
