import { type Principal, can } from '@holtkeeper/access'
import type {
  GitHubTokenUsage,
  LibraryDetail,
  LibraryList,
  LibraryReindexResult,
  LibrarySearchResult,
  LibrarySummary,
} from '@holtkeeper/api'
import { githubTokenInfo } from '@holtkeeper/libraries'
import type {
  LibraryChunk,
  LibraryEcosystem,
  LibraryRecord,
  LibraryVersionRecord,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, authorize, principalOf, repoTarget } from '../context.ts'
import { githubTokenUsage, githubUsageFor, resolveGitHubTokens } from '../github-usage.ts'
import {
  lastLibraryRun,
  libraryReader,
  librariesConfigOf,
  librariesEnabled,
  requestLibraryIndex,
} from '../libraries.ts'
import { canSee } from '../visibility.ts'

const GLOBAL = { kind: 'global' } as const
const DOCUMENT_CHUNKS = 100_000
const TOKEN_INFO_MS = 60_000

const ecosystemParam = (value: string | undefined): LibraryEcosystem | undefined => {
  if (!value) return undefined
  if (value === 'npm' || value === 'Go') return value
  if (value.toLowerCase() === 'go') return 'Go'
  throw new HTTPException(400, { message: 'ecosystem must be npm or Go' })
}

const failedSources = (library: LibraryRecord, versions: LibraryVersionRecord[]) =>
  [
    ...new Set(
      [library.sources, ...versions.map((version) => version.sources)].flatMap((sources) =>
        Object.entries(sources)
          .filter(([, status]) => status?.status === 'failed')
          .map(([source]) => source),
      ),
    ),
  ].toSorted()

/**
 * `/api/libraries`: the third-party library index for the web UI. A library is visible to callers
 * who may read (`analyses:read`) a repository that uses it, and libraries no repository uses to
 * callers with global `analyses:read`; `usedBy` lists only readable repositories.
 */
export function libraryRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const routes = new Hono<Env>()
  const readerOf = (principal: Principal) =>
    libraryReader({
      canRead: (repo) => canSee(principal, 'analyses:read', repoTarget(config, repo)),
      global: can(principal, 'analyses:read', GLOBAL),
    })
  const enabled = async () =>
    store.libraries !== undefined && librariesEnabled(await librariesConfigOf(store.settings))

  routes.get('/libraries', async (c) => {
    const reader = readerOf(principalOf(c))
    const lastRun = await lastLibraryRun(store.kv)
    const on = await enabled()
    const libraries = store.libraries
    if (!libraries) return c.json<LibraryList>({ libraries: [], enabled: false })
    const ecosystem = ecosystemParam(c.req.query('ecosystem'))
    const query = c.req.query('q')?.trim()
    const records = await libraries.listLibraries({
      ...(ecosystem ? { ecosystem } : {}),
      ...(query ? { query } : {}),
    })
    const stats = await libraries.libraryStats(ecosystem ? { ecosystem } : {})
    const summaries: LibrarySummary[] = []
    for (const library of records) {
      // oxlint-disable-next-line no-await-in-loop -- one library after another keeps the store calm
      const versions = await libraries.listVersions(library)
      const { visible, readable } = reader.view(versions)
      if (!visible) continue
      summaries.push({
        ecosystem: library.ecosystem,
        name: library.name,
        ...(library.description ? { description: library.description } : {}),
        ...(library.latest ? { latest: library.latest } : {}),
        ...(library.repository ? { repository: library.repository.url } : {}),
        versions: versions.filter((version) => version.roles.length).map((v) => v.version),
        repos: readable.length,
        chunks: stats.get(`${library.ecosystem}:${library.name}`)?.chunks ?? 0,
        issues: stats.get(`${library.ecosystem}:${library.name}`)?.issues ?? 0,
        failed: failedSources(library, versions),
        updatedAt: library.updatedAt,
      })
    }
    return c.json<LibraryList>({
      libraries: summaries,
      ...(lastRun ? { lastRun } : {}),
      enabled: on,
    })
  })

  routes.get('/libraries/search', async (c) => {
    const reader = readerOf(principalOf(c))
    const libraries = store.libraries
    const text = c.req.query('q')?.trim() ?? ''
    if (!libraries || !text) return c.json<LibrarySearchResult>({ hits: [] })
    const ecosystem = ecosystemParam(c.req.query('ecosystem'))
    const name = c.req.query('name')
    const version = c.req.query('version')
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100)
    const hits = await libraries.searchChunks(
      text,
      {
        ...(ecosystem ? { ecosystem } : {}),
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
      },
      limit,
    )
    const visible = new Map<string, boolean>()
    const result: LibrarySearchResult['hits'] = []
    for (const hit of hits) {
      const key = `${hit.chunk.ecosystem}:${hit.chunk.name}`
      let shown = visible.get(key)
      if (shown === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a few libraries per result
        shown = reader.view(await libraries.listVersions(hit.chunk)).visible
        visible.set(key, shown)
      }
      if (shown) result.push(hit)
    }
    return c.json<LibrarySearchResult>({ hits: result })
  })

  const tokenInfo = new Map<string, { at: number; info: ReturnType<typeof githubTokenInfo> }>()
  const cachedInfo = (token: string | undefined) => {
    const key = token ?? ''
    const hit = tokenInfo.get(key)
    const at = deps.now().getTime()
    if (hit && at - hit.at < TOKEN_INFO_MS) return hit.info
    const info = githubTokenInfo(token)
    tokenInfo.set(key, { at, info })
    return info
  }

  routes.get('/libraries/github', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const days = Math.min(90, Math.max(1, Math.trunc(Number(c.req.query('days') ?? 30)) || 30))
    const settings = await librariesConfigOf(store.settings)
    return c.json<GitHubTokenUsage>(
      await githubTokenUsage({
        credentials: await resolveGitHubTokens(deps.credentials, settings?.github ?? []),
        usage: githubUsageFor(store.kv),
        days,
        now: deps.now,
        info: cachedInfo,
      }),
    )
  })

  routes.post('/libraries/reindex', async (c) => {
    authorize(c, 'analyses:run', GLOBAL)
    if (!store.libraries)
      throw new HTTPException(503, { message: 'the store keeps no library index' })
    if (!(await enabled()))
      throw new HTTPException(409, { message: 'library indexing is off (setting `libraries`)' })
    if (!store.kv) throw new HTTPException(503, { message: 'the store keeps no key-value state' })
    return c.json<LibraryReindexResult>({ started: await requestLibraryIndex(store.kv) })
  })

  routes.get('/libraries/:ecosystem/:name{.+}', async (c) => {
    const reader = readerOf(principalOf(c))
    const libraries = store.libraries
    const ecosystem = ecosystemParam(c.req.param('ecosystem'))
    const name = c.req.param('name')
    const notFound = () => new HTTPException(404, { message: `no indexed library ${name}` })
    if (!libraries || !ecosystem) throw notFound()
    const ref = { ecosystem, name }
    const library = await libraries.getLibrary(ref)
    if (!library) throw notFound()
    const versions = await libraries.listVersions(ref)
    if (!reader.view(versions).visible) throw notFound()
    const newest = versions.find((version) => version.roles.length) ?? versions[0]
    const documents = new Map<
      string,
      { source: LibraryChunk['source']; path: string; chunks: number }
    >()
    if (newest)
      for (const chunk of await libraries.listChunks(
        { ...ref, version: newest.version },
        DOCUMENT_CHUNKS,
      )) {
        const key = `${chunk.source}\u0000${chunk.path}`
        const entry = documents.get(key) ?? { source: chunk.source, path: chunk.path, chunks: 0 }
        entry.chunks += 1
        documents.set(key, entry)
      }
    return c.json<LibraryDetail>({
      library,
      versions: versions.map((version) => ({
        ...version,
        usedBy: version.usedBy.filter(reader.canRead),
      })),
      documents: [...documents.values()].toSorted(
        (a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path),
      ),
    })
  })

  return routes
}
