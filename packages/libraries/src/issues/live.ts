import type { LibraryRepository } from '@holtkeeper/store'

import type { GitHubClient } from '../github/client.ts'
import { GitHubRateLimitError } from '../github/client.ts'
import { type FetchedIssue, type RestIssue, fromRest } from './shared.ts'

/** A key-value cache with expiry, e.g. the server's shared cache. Values are JSON-serializable. */
export interface IssueSearchCache {
  /** `undefined` when missing or expired. */
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>
}

export interface LiveIssueHits {
  issues: FetchedIssue[]
  /** Why results are missing or partial (rate limit, unsupported host, failure). */
  note?: string
}

/**
 * Searches a repository's issues on its forge, best match first, at most `limit`. Never throws:
 * failures come back as an empty list with a `note`.
 */
export type LiveIssueSearch = (
  repo: LibraryRepository,
  query: string,
  limit: number,
) => Promise<LiveIssueHits>

export interface LiveIssueSearchOptions {
  github: GitHubClient
  cache?: IssueSearchCache
  /** Default one day. */
  ttlSeconds?: number
}

const PER_PAGE = 20
const MAX_QUERY = 200

/** Search text with GitHub qualifiers (`repo:`, `is:`, …) removed, so it stays inside the repository. */
export function searchTerms(query: string): string {
  return query
    .replace(/(?:^|\s)-?[a-z]+:(?:"[^"]*"|\S+)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY)
}

const isFetched = (value: unknown): value is FetchedIssue[] =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) =>
      typeof item === 'object' && item !== null && typeof Reflect.get(item, 'id') === 'string',
  )

/**
 * `GET /search/issues` scoped to the repository (issues only), results cached for a day per
 * repository and query. GitHub allows 30 searches a minute: the client waits out short limits and,
 * when it gives up, the search answers with a note instead of results. GitHub repositories only.
 */
export function liveIssueSearch(options: LiveIssueSearchOptions): LiveIssueSearch {
  const ttl = options.ttlSeconds ?? 86_400
  return async (repo, query, limit) => {
    if (repo.host !== 'github.com')
      return { issues: [], note: `live issue search supports GitHub only, not ${repo.host}` }
    const terms = searchTerms(query)
    if (!terms) return { issues: [] }
    const key = `libraries:issues:${repo.host}/${repo.path.toLowerCase()}:${terms.toLowerCase()}`
    const cached = await options.cache?.get(key)
    if (isFetched(cached)) return { issues: cached.slice(0, limit) }
    const q = encodeURIComponent(`${terms} repo:${repo.path} is:issue`)
    try {
      const response = await options.github.rest<{ items?: RestIssue[] }>(
        `/search/issues?q=${q}&per_page=${PER_PAGE}`,
      )
      const issues = (response.data?.items ?? [])
        .filter((item) => item.pull_request === undefined)
        .map((item) => fromRest(repo, item))
      await options.cache?.set(key, issues, ttl)
      return { issues: issues.slice(0, limit) }
    } catch (error) {
      if (error instanceof GitHubRateLimitError)
        return { issues: [], note: `live search skipped: ${error.message}` }
      return {
        issues: [],
        note: `live search failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}
