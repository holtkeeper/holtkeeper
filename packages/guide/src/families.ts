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
  /** A proposed name, from the members' common path. */
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

function proposedName(members: readonly string[], framework: string | undefined): string {
  const paths = members.map((member) => member.slice(member.indexOf(':') + 1))
  let prefix = paths[0] ?? ''
  for (const path of paths) while (!path.startsWith(prefix)) prefix = prefix.slice(0, -1)
  prefix = prefix.replace(/[^\p{L}\p{N}]+$/u, '')
  const base = prefix || framework || 'similar'
  return framework && prefix ? `${base} (${framework})` : base
}

/**
 * Proposes families: repositories with the same framework and toolchain whose direct dependency
 * names are similar (complete linkage: every two members reach `threshold`). Repositories without
 * dependencies and `exclude`d ones are never proposed. The result is deterministic: the same
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
    .map((signal) => ({
      repo: signal.repo,
      deps: new Set(signal.dependencies),
      framework: frameworkOf(signal.dependencies),
      toolchain: [...new Set(signal.toolchain ?? [])].toSorted(binary),
    }))
    .toSorted((a, b) => binary(a.repo, b.repo))

  const bySignature = new Map<string, typeof repos>()
  for (const repo of repos) {
    const signature = `${repo.framework ?? ''}|${repo.toolchain.join(',')}`
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), repo])
  }

  const suggestions: FamilySuggestion[] = []
  for (const group of bySignature.values()) {
    if (group.length < minSize) continue
    const similarity = group.map((a) => group.map((b) => jaccard(a.deps, b.deps)))
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
        similarity: Math.round(linkage(cluster, cluster) * 1000) / 1000,
        ...(first.framework && { framework: first.framework }),
        toolchain: first.toolchain,
        shared: shared.slice(0, 10),
      })
    }
  }
  return suggestions.toSorted(
    (a, b) =>
      b.members.length - a.members.length ||
      b.similarity - a.similarity ||
      binary(a.members[0] ?? '', b.members[0] ?? ''),
  )
}

/** Identity of a suggestion across runs: its members as a set, sorted and joined by `,`. */
export const suggestionKey = (members: readonly string[]): string =>
  [...new Set(members)].toSorted(binary).join(',')

/** The family `repo` (`forge:path`) belongs to, if any. */
export const familyOf = (families: readonly Family[], repo: string): Family | undefined =>
  families.find((family) => family.members.includes(repo))
