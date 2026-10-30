import { resolveSecret, type Secret } from '@holtkeeper/forge'
import { z } from 'zod'

import { ConfluenceApiError, ConfluenceInputError, VersionConflictError } from './errors.ts'
import { sanitizeHtml } from './html.ts'
import { createConfluenceClient, type FetchLike } from './http.ts'
import { markdownToStorage } from './markdown.ts'
import { assertMarkerId, replaceSectionInStorage } from './markers.ts'
import { parsePageRef } from './ref.ts'
import type { DocumentFormat, DocumentSink, DocumentSource, SourceDocument } from './types.ts'

/** How requests authenticate. */
export type ConfluenceAuth =
  /** Cloud: Atlassian account email and API token. */
  | { kind: 'basic'; email: string; token: Secret }
  /** Data Center / Server: personal access token. */
  | { kind: 'bearer'; token: Secret }

/** Which REST API the site speaks: Cloud REST v2 or Data Center REST v1. */
export type ConfluenceFlavor = 'cloud' | 'datacenter'

export interface ConfluenceOptions {
  /**
   * Site URL: `https://example.atlassian.net` (with or without `/wiki`), the API gateway
   * `https://api.atlassian.com/ex/confluence/<cloudId>`, or a Data Center base URL including its
   * context path (`https://wiki.example.com/confluence`).
   */
  url: string
  auth: ConfluenceAuth
  fetch?: FetchLike
  /** Default: `cloud` for `*.atlassian.net` and `api.atlassian.com`, `datacenter` otherwise. */
  flavor?: ConfluenceFlavor
  /** How often a `429` is retried after waiting for `Retry-After` (capped at 60 s). Default 1. */
  retries?: number
}

/** A Confluence site as a document source and sink, both with `provider: 'confluence'`. */
export interface Confluence {
  source: DocumentSource
  sink: DocumentSink
}

/** Picks the flavor for a site URL when none is configured. */
export function detectFlavor(url: string): ConfluenceFlavor {
  const host = new URL(url).hostname.toLowerCase()
  return host.endsWith('.atlassian.net') || host === 'api.atlassian.com' ? 'cloud' : 'datacenter'
}

const linksSchema = z
  .object({ webui: z.string().optional(), base: z.string().optional() })
  .optional()

const pageSchema = z.object({
  id: z.coerce.string(),
  type: z.string().optional(),
  status: z.string(),
  title: z.string(),
  version: z.object({ number: z.number().int().positive() }),
  body: z.object({ storage: z.object({ value: z.string() }) }),
  _links: linksSchema,
})

const updatedSchema = z.object({
  version: z.object({ number: z.number().int().positive() }),
  _links: linksSchema,
})

interface Page {
  id: string
  type: string
  status: string
  title: string
  version: number
  body: string
  url: string
}

const trimSlashes = (value: string) => value.replace(/\/+$/, '')

function toStorage(content: string, format: DocumentFormat): string {
  if (format === 'markdown') return markdownToStorage(content)
  if (format === 'html') return sanitizeHtml(content)
  if (format === 'storage') return content
  throw new ConfluenceInputError(`unsupported format ${JSON.stringify(format)}`)
}

/** Creates a document source and sink for one Confluence site. The token is resolved on first use. */
export function confluence(options: ConfluenceOptions): Confluence {
  if (!URL.canParse(options.url) || !['http:', 'https:'].includes(new URL(options.url).protocol))
    throw new ConfluenceInputError('url must be an http(s) URL')
  const flavor = options.flavor ?? detectFlavor(options.url)
  const site = new URL(options.url)
  site.search = ''
  site.hash = ''
  const base = trimSlashes(site.toString())
  const cloudBase = base.replace(/\/wiki$/i, '')
  const webBase = flavor === 'cloud' ? `${cloudBase}/wiki` : base
  const pageApi = (id: string) =>
    flavor === 'cloud'
      ? `${cloudBase}/wiki/api/v2/pages/${encodeURIComponent(id)}`
      : `${base}/rest/api/content/${encodeURIComponent(id)}`

  let resolved: { authorization: string; secrets: string[] } | undefined
  const credentials = () => {
    if (resolved) return resolved
    const token = resolveSecret(options.auth.token)
    if (options.auth.kind === 'basic') {
      const encoded = Buffer.from(`${options.auth.email}:${token}`).toString('base64')
      resolved = { authorization: `Basic ${encoded}`, secrets: [token, encoded] }
    } else resolved = { authorization: `Bearer ${token}`, secrets: [token] }
    return resolved
  }

  const client = createConfluenceClient({
    authorization: () => credentials().authorization,
    secrets: () => resolved?.secrets ?? [],
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    retries: options.retries ?? 1,
  })

  const pageUrl = (id: string, links: z.infer<typeof linksSchema>) => {
    const linkBase =
      links?.base && /^https?:\/\//i.test(links.base) ? trimSlashes(links.base) : webBase
    if (links?.webui?.startsWith('/')) return `${linkBase}${links.webui}`
    return `${webBase}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`
  }

  const getPage = async (id: string): Promise<Page> => {
    const url = new URL(pageApi(id))
    if (flavor === 'cloud') url.searchParams.set('body-format', 'storage')
    else url.searchParams.set('expand', 'body.storage,version')
    const page = await client.json('GET', url.toString(), pageSchema)
    return {
      id: page.id,
      type: page.type ?? 'page',
      status: page.status,
      title: page.title,
      version: page.version.number,
      body: page.body.storage.value,
      url: pageUrl(page.id, page['_links']),
    }
  }

  const putPage = (page: Page, body: string, message: string | undefined) => {
    const version = { number: page.version + 1, ...(message ? { message } : {}) }
    const payload =
      flavor === 'cloud'
        ? {
            id: page.id,
            status: 'current',
            title: page.title,
            body: { representation: 'storage', value: body },
            version,
          }
        : {
            id: page.id,
            type: page.type,
            status: 'current',
            title: page.title,
            body: { storage: { value: body, representation: 'storage' } },
            version,
          }
    return client.json('PUT', pageApi(page.id), updatedSchema, payload)
  }

  const source: DocumentSource = {
    provider: 'confluence',
    async read(ref): Promise<SourceDocument> {
      const page = await getPage(parsePageRef(ref, options.url))
      return {
        ref,
        title: page.title,
        version: page.version,
        url: page.url,
        format: 'storage',
        body: page.body,
      }
    },
  }

  const sink: DocumentSink = {
    provider: 'confluence',
    async replaceSection(ref, input) {
      assertMarkerId(input.markerId)
      const content = toStorage(input.content, input.format)
      const page = await getPage(parsePageRef(ref, options.url))
      if (input.expectedVersion !== undefined && input.expectedVersion !== page.version)
        throw new VersionConflictError(page.id, input.expectedVersion, page.version)
      if (page.status !== 'current')
        throw new ConfluenceInputError(
          `page ${page.id} has status ${page.status}; only current pages are updated`,
        )
      const update = replaceSectionInStorage(page.body, input.markerId, content)
      if (!update.changed) return { version: page.version, url: page.url, changed: false }
      try {
        const saved = await putPage(page, update.body, input.message)
        return { version: saved.version.number, url: page.url, changed: true }
      } catch (error) {
        if (!(error instanceof ConfluenceApiError) || error.status !== 409) throw error
        // Cloud also answers 409 when content approval blocks publishing; only a moved version is a conflict.
        const latest = await getPage(page.id)
        if (latest.version !== page.version)
          throw new VersionConflictError(page.id, page.version, latest.version)
        throw error
      }
    },
  }

  return { source, sink }
}
