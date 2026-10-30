import { ConfluenceInputError } from './errors.ts'

/**
 * Extracts a page id from `ref`: a bare numeric id, or a page link with `/pages/<id>` in its path
 * (Cloud, `…/pages/edit-v2/<id>` too) or a `pageId` query parameter (Data Center). A link must
 * point at `siteUrl`'s host unless the site is reached through `api.atlassian.com`. Throws `ConfluenceInputError` otherwise; tiny links (`/x/…`) are not
 * resolved.
 */
export function parsePageRef(ref: string, siteUrl: string): string {
  const value = ref.trim()
  if (/^\d+$/.test(value)) return value
  if (!URL.canParse(value))
    throw new ConfluenceInputError(`not a Confluence page id or link: ${JSON.stringify(ref)}`)
  const url = new URL(value)
  const site = new URL(siteUrl).host.toLowerCase()
  // Through the api.atlassian.com gateway the site's own host is unknown.
  if (site !== 'api.atlassian.com' && url.host.toLowerCase() !== site)
    throw new ConfluenceInputError(`page link ${url.host} is not on the configured site ${site}`)
  const query = url.searchParams.get('pageId')
  if (query !== null && /^\d+$/.test(query)) return query
  const path = /\/pages\/(?:[a-z][a-z0-9-]*\/)*(\d+)(?:\/|$)/i.exec(url.pathname)
  if (path) return path[1]!
  throw new ConfluenceInputError(`no page id in link ${url.origin}${url.pathname}`)
}
