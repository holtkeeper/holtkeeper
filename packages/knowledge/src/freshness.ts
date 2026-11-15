import type { KnowledgeEntry, KvStore } from '@holtkeeper/store'
import { z } from 'zod'

/** How sure we are an accepted entry still holds. */
export const freshnessStatuses = ['fresh', 'suspect', 'stale'] as const

export type FreshnessStatus = (typeof freshnessStatuses)[number]

/** Why an entry was looked at again. */
export const freshnessSignalKinds = [
  'missing-file',
  'changed-file',
  'package-gone',
  'aged',
] as const

export type FreshnessSignalKind = (typeof freshnessSignalKinds)[number]

/** One reason an entry may be outdated, with the file or package it is about. */
export interface FreshnessSignal {
  kind: FreshnessSignalKind
  detail: string
}

/**
 * The result of the last check of an entry (`Store.kv`, key `freshnessKey(id)`):
 * `fresh` nothing it rests on changed, or a model confirmed it still holds; `suspect` something
 * changed and the model proposed a replacement (`proposal`) or could not decide; `stale` the model
 * found it no longer true. Nothing is archived on its own, people decide.
 */
export interface KnowledgeFreshness {
  status: FreshnessStatus
  /** When the entry was last checked, by signals or by a model. */
  checkedAt: string
  /**
   * When a model last judged the entry's content, or when the first check found nothing; signal-only
   * checks carry it over, so `aged` fires 90 days after it however often the commit moved.
   */
  judgedAt?: string
  /** Commit of the default branch the check read. */
  sha?: string
  /** `signals`: only the deterministic filter looked; `model`: a model judged it. */
  method: 'signals' | 'model'
  /** The repository whose code was read, `forge:path`. */
  repo: string
  reason?: string
  signals: FreshnessSignal[]
  /** Id of the entry proposed to replace this one. */
  proposal?: string
}

const schema: z.ZodType<KnowledgeFreshness> = z.object({
  status: z.enum(freshnessStatuses),
  checkedAt: z.string(),
  judgedAt: z.string().optional(),
  sha: z.string().optional(),
  method: z.enum(['signals', 'model']),
  repo: z.string(),
  reason: z.string().optional(),
  signals: z.array(z.object({ kind: z.enum(freshnessSignalKinds), detail: z.string() })),
  proposal: z.string().optional(),
})

/** The `Store.kv` key of an entry's freshness: `knowledge:fresh:<id>`. */
export const freshnessKey = (id: string): string => `knowledge:fresh:${id}`

/** The stored freshness of each entry in `ids` that has a valid one. */
export async function readFreshness(
  kv: Pick<KvStore, 'get'> | undefined,
  ids: readonly string[],
): Promise<Map<string, KnowledgeFreshness>> {
  const found = new Map<string, KnowledgeFreshness>()
  if (!kv) return found
  await Promise.all(
    ids.map(async (id) => {
      const parsed = schema.safeParse(await kv.get(freshnessKey(id)))
      if (parsed.success) found.set(id, parsed.data)
    }),
  )
  return found
}

/** Stores the result of a check. */
export const writeFreshness = (
  kv: Pick<KvStore, 'set'>,
  id: string,
  value: KnowledgeFreshness,
): Promise<void> => kv.set(freshnessKey(id), value)

/** Entries are looked at again after this many days even when nothing they rest on changed. */
export const FRESHNESS_MAX_AGE_DAYS = 90

/**
 * Repository-relative paths an entry's evidence links point to in `repo` (GitLab `/-/blob/<ref>/…`
 * and `/-/tree/…`, GitHub `/blob/<ref>/…`, `/tree/…`); links into other repositories and merge
 * request links give none. Sorted, unique.
 */
export function evidencePaths(entry: Pick<KnowledgeEntry, 'evidence'>, repoPath: string): string[] {
  return [...new Set(evidenceLinks(entry, repoPath).map((link) => link.path))].toSorted()
}

/**
 * Commits evidence links into `repo` were made at (a 40-character sha as the `blob`/`tree` ref;
 * branch names do not count). Sorted, unique. The first check of an entry diffs from there.
 */
export function evidenceCommits(
  entry: Pick<KnowledgeEntry, 'evidence'>,
  repoPath: string,
): string[] {
  return [
    ...new Set(
      evidenceLinks(entry, repoPath)
        .map((link) => link.ref)
        .filter((ref) => /^[0-9a-f]{40}$/.test(ref)),
    ),
  ].toSorted()
}

function evidenceLinks(
  entry: Pick<KnowledgeEntry, 'evidence'>,
  repoPath: string,
): { ref: string; path: string }[] {
  const prefix = `/${repoPath.replace(/^\/+|\/+$/g, '')}/`
  return entry.evidence.flatMap((link) => {
    let pathname: string
    try {
      pathname = new URL(link.url).pathname
    } catch {
      return []
    }
    // The repository path must start the URL path: `/acme/web/` is not inside `/x/acme/web/`.
    if (!pathname.startsWith(prefix)) return []
    const rest = pathname.slice(prefix.length).replace(/^-\//, '')
    const found = /^(?:blob|tree)\/([^/]+)\/(.+)$/.exec(rest)
    if (!found?.[1] || !found[2]) return []
    try {
      return [{ ref: found[1], path: decodeURIComponent(found[2]).replace(/\/$/, '') }]
    } catch {
      return []
    }
  })
}

/** The subjects of a package entry as dependency names: `npm:react` → `react`. */
const packageNames = (entry: Pick<KnowledgeEntry, 'packages' | 'subject'>) =>
  new Set<string>([
    ...(entry.packages ?? []).map((pkg) => `${pkg.ecosystem}:${pkg.name}`),
    ...(entry.subject && /^(npm|Go):/.test(entry.subject) ? [entry.subject] : []),
  ])

/** What a freshness check knows about the repository's current state. */
export interface RepositoryState {
  /**
   * Repository-relative paths known to exist (files or folders); at least every evidence path of
   * the entries checked. A folder also counts when a listed file lies in it.
   */
  files: ReadonlySet<string>
  /** Files changed since the entry was last checked; `undefined` when that is unknown. */
  changed?: ReadonlySet<string>
  /** Direct dependencies as subjects (`npm:react`, `Go:example.com/kit`). */
  dependencies: ReadonlySet<string>
  now: Date
}

const isDirectory = (path: string, files: ReadonlySet<string>) => {
  const prefix = `${path.replace(/\/$/, '')}/`
  for (const file of files) if (file.startsWith(prefix)) return true
  return false
}

/**
 * Deterministic reasons to doubt that an entry still holds in `repoPath`:
 * an evidence file is gone (`missing-file`) or changed since the last check (`changed-file`),
 * a `match.files` glob matches a changed file (`changed-file`), a package the entry is about is
 * no longer a direct dependency (`package-gone`; only for `npm` and `Go`, and only when
 * the repository has dependencies of that ecosystem), or the last check is older than `FRESHNESS_MAX_AGE_DAYS`
 * (`aged`, counted from `judgedAt`: when a model last judged it, else the entry's own update). No signals
 * means nothing the entry rests on moved.
 */
export function freshnessSignals(input: {
  entry: KnowledgeEntry
  repoPath: string
  state: RepositoryState
  judgedAt?: string
}): FreshnessSignal[] {
  const { entry, repoPath, state } = input
  const signals: FreshnessSignal[] = []
  for (const path of evidencePaths(entry, repoPath)) {
    if (!state.files.has(path) && !isDirectory(path, state.files))
      signals.push({ kind: 'missing-file', detail: path })
    else if (state.changed?.has(path)) signals.push({ kind: 'changed-file', detail: path })
  }
  const globs = (entry.match?.files ?? []).map((pattern) => ({
    pattern,
    glob: new Bun.Glob(pattern.replace(/^(\.\/|\/)+/, '')),
  }))
  if (state.changed)
    for (const { pattern, glob } of globs) {
      const hit = [...state.changed].find((file) => glob.match(file))
      if (hit) signals.push({ kind: 'changed-file', detail: `${hit} (matches ${pattern})` })
    }
  // Only ecosystems whose dependencies were read count: a repository without a go.mod says
  // nothing about Go packages.
  const read = new Set([...state.dependencies].map((subject) => subject.split(':')[0]))
  for (const name of packageNames(entry))
    if (read.has(name.split(':')[0]) && /^(npm|Go):/.test(name) && !state.dependencies.has(name))
      signals.push({ kind: 'package-gone', detail: name })
  const since = Date.parse(input.judgedAt ?? entry.updatedAt)
  if (Number.isFinite(since) && state.now.getTime() - since > FRESHNESS_MAX_AGE_DAYS * 86_400_000)
    signals.push({ kind: 'aged', detail: `${FRESHNESS_MAX_AGE_DAYS}+ days` })
  return signals
}
