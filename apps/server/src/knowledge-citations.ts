import {
  type CitingRun,
  type KnowledgeCitation,
  knowledgeCitations,
  reviewDataSchema,
} from '@holtkeeper/review'
import type { Store } from '@holtkeeper/store'

/** How long the citations of every entry are kept before stored reviews are read again. */
const CITATIONS_TTL_MS = 10 * 60_000

/** Review runs read per page, and at most in all (newest first). */
const PAGE = 200
const CITATIONS_SCAN = 5000

/** Citations are looked for in reviews of this many days back. */
const CITATIONS_DAYS = 365

/** Shortest prefix of an entry id a citation may use. */
const MIN_PREFIX = 8

/** Review comments citing knowledge entries, by entry id. */
export interface CitationIndex {
  /**
   * Every posted review comment citing an existing entry (`knowledgeCitations`) of the reviews of
   * the last `CITATIONS_DAYS` days (at most `CITATIONS_SCAN` runs), keyed by the entry's id; a
   * citation by a unique id prefix of at least eight characters counts for that entry.
   */
  all(): Promise<ReadonlyMap<string, readonly KnowledgeCitation[]>>
}

/**
 * A `CitationIndex` over the stored review records, their comments' signals and the knowledge
 * entries, read at most every `ttlMs` (default `CITATIONS_TTL_MS`); a failed read is retried on the
 * next call.
 */
export function createCitationIndex(deps: {
  store: Pick<Store, 'analyses' | 'learnings' | 'knowledge'>
  now: () => Date
  ttlMs?: number
}): CitationIndex {
  const ttl = deps.ttlMs ?? CITATIONS_TTL_MS
  let cached: { at: number; load: Promise<Map<string, KnowledgeCitation[]>> } | undefined

  const read = async (): Promise<Map<string, KnowledgeCitation[]>> => {
    const since = new Date(deps.now().getTime() - CITATIONS_DAYS * 86_400_000).toISOString()
    const runs: CitingRun[] = []
    let before: string | undefined
    for (let scanned = 0; scanned < CITATIONS_SCAN;) {
      // oxlint-disable-next-line no-await-in-loop -- each page starts where the previous one ended
      const page = await deps.store.analyses.list({
        kind: 'review',
        since,
        ...(before && { before }),
        limit: Math.min(PAGE, CITATIONS_SCAN - scanned),
      })
      scanned += page.length
      for (const record of page) {
        const data = reviewDataSchema.safeParse(record.data).data
        if (data?.comments.length)
          runs.push({
            repo: `${record.repo.forge}:${record.repo.path}`,
            createdAt: record.createdAt,
            data,
          })
      }
      if (page.length < PAGE) break
      before = page.at(-1)?.createdAt
    }
    const [signals, entries] = await Promise.all([
      deps.store.learnings.reactions(),
      deps.store.knowledge.list(),
    ])
    const ids = entries.map((entry) => entry.id)
    const known = new Set(ids)
    const resolve = (cited: string): string | undefined => {
      if (known.has(cited)) return cited
      if (cited.length < MIN_PREFIX) return undefined
      const matches = ids.filter((id) => id.startsWith(cited))
      return matches.length === 1 ? matches[0] : undefined
    }
    const result = new Map<string, KnowledgeCitation[]>()
    for (const citation of knowledgeCitations(runs, signals)) {
      const id = resolve(citation.entry)
      if (id === undefined) continue
      const list = result.get(id) ?? []
      // A comment citing the same entry by full id and by prefix counts once.
      if (
        !list.some(
          (other) =>
            other.repo === citation.repo &&
            other.mergeRequest === citation.mergeRequest &&
            other.findingId === citation.findingId,
        )
      )
        list.push({ ...citation, entry: id })
      result.set(id, list)
    }
    return result
  }

  return {
    all() {
      const now = deps.now().getTime()
      if (cached && now - cached.at < ttl) return cached.load
      const load = read()
      const entry = { at: now, load }
      cached = entry
      load.catch(() => {
        if (cached === entry) cached = undefined
      })
      return load
    },
  }
}
