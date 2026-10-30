import type { TokenInfo, TokenRotator } from '@holtkeeper/credentials'
import { z } from 'zod'

import { apiUrl, GitLabApiError, gitlabMessage, type FetchLike } from './http.ts'

export { GitLabApiError, type FetchLike } from './http.ts'

export interface GitLabTokenRotatorOptions {
  fetch?: FetchLike
  /** Clock used to compute the new expiry date. */
  now?: () => Date
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const tokenSchema = z.object({
  name: z.string(),
  scopes: z.array(z.string()),
  expires_at: isoDate.nullable().optional(),
})

const rotatedSchema = z.object({
  token: z.string().min(1),
  expires_at: isoDate,
})

const DAY_MS = 86_400_000
const SELF = 'personal_access_tokens/self'

// GitLab tokens stop working at 00:00 UTC on their expiry date.
const dateToTimestamp = (date: string) => `${date}T00:00:00.000Z`

/**
 * Rotates and inspects GitLab personal access tokens through the token's own `self` endpoints, so
 * rotating needs only the `api` or `self_rotate` scope on the token itself. `url`
 * is the GitLab base URL, with or without a trailing slash, including any path prefix of a
 * self-managed instance (`https://example.com/gitlab`). Rotation revokes the old token at once.
 * Errors are `GitLabApiError` for HTTP failures; aborting via `signal` rejects with the abort reason.
 */
export function gitlabTokenRotator(options: GitLabTokenRotatorOptions = {}): TokenRotator {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())

  const request = async <T>(
    method: 'GET' | 'POST',
    url: string,
    path: string,
    token: string,
    schema: z.ZodType<T>,
    init: { body?: unknown; signal?: AbortSignal },
  ): Promise<T> => {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetchImpl(apiUrl(url, path), {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // fetch keeps custom headers such as PRIVATE-TOKEN across cross-origin redirects.
      redirect: 'error',
      signal: init.signal,
    })
    const label = `GitLab ${method} /api/v4/${path}`
    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const raw = gitlabMessage(body) ?? (response.statusText || 'no error message')
      const detail = (token ? raw.replaceAll(token, '[redacted]') : raw).slice(0, 500)
      const hint =
        response.status === 405 && path.endsWith('/rotate')
          ? ' (only personal access tokens can use this endpoint; project and group access tokens rotate through /projects/:id/access_tokens/self/rotate or /groups/:id/access_tokens/self/rotate)'
          : ''
      throw new GitLabApiError(
        response.status,
        `${label} failed with ${response.status}: ${detail}${hint}`,
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      // The body may contain a token, so only field paths are reported.
      const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(body)').join(', ')
      throw new GitLabApiError(
        response.status,
        `${label} returned an unexpected response (${fields})`,
      )
    }
    return parsed.data
  }

  return {
    kind: 'gitlab',

    async inspect({ url, token, signal }): Promise<TokenInfo> {
      const info = await request('GET', url, SELF, token, tokenSchema, { signal })
      const result: TokenInfo = { name: info.name, scopes: info.scopes }
      if (info.expires_at) result.expiresAt = dateToTimestamp(info.expires_at)
      return result
    },

    async rotate({ url, token, lifetimeDays, signal }) {
      if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1)
        throw new Error('lifetimeDays must be a positive integer')
      const expiresAt = new Date(now().getTime() + lifetimeDays * DAY_MS).toISOString().slice(0, 10)
      const rotated = await request('POST', url, `${SELF}/rotate`, token, rotatedSchema, {
        body: { expires_at: expiresAt },
        signal,
      })
      return { token: rotated.token, expiresAt: dateToTimestamp(rotated.expires_at) }
    },
  }
}
