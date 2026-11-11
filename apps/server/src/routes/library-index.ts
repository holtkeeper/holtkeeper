import type {
  GitHubTokenUsage,
  LibraryIndexStatus,
  LibraryReindexResult,
  LibrarySummary,
} from '@holtkeeper/api'
import { githubTokenInfo } from '@holtkeeper/libraries'
import type { LibraryEcosystem, LibraryRecord, LibraryVersionRecord } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, authorize } from '../context.ts'
import { githubTokenUsage, githubUsageFor, resolveGitHubTokens } from '../github-usage.ts'
import {
  lastLibraryRun,
  librariesConfigOf,
  librariesEnabled,
  requestLibraryIndex,
} from '../libraries.ts'
import { libraryProgress, librarySourceCoverage } from '../library-progress.ts'

const GLOBAL = { kind: 'global' } as const
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
 * `/api/system/library-index`: the library index admin for Settings → System. `GET` lists what
 * the index holds with its last run, the run going on and source coverage (global
 * `settings:read`); `POST …/reindex` asks for a run (global `analyses:run`); `GET …/github` shows
 * use and limits of the GitHub tokens (global `settings:read`).
 */
export function libraryIndexRoutes(deps: ServerDeps) {
  const { store } = deps
  const routes = new Hono<Env>()
  const enabled = async () =>
    store.libraries !== undefined && librariesEnabled(await librariesConfigOf(store.settings))

  routes.get('/system/library-index', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const lastRun = await lastLibraryRun(store.kv)
    const on = await enabled()
    const libraries = store.libraries
    if (!libraries)
      return c.json<LibraryIndexStatus>({ libraries: [], enabled: false, coverage: [] })
    const ecosystem = ecosystemParam(c.req.query('ecosystem'))
    const query = c.req.query('q')?.trim()
    const records = await libraries.listLibraries({
      ...(ecosystem ? { ecosystem } : {}),
      ...(query ? { query } : {}),
    })
    const stats = await libraries.libraryStats(ecosystem ? { ecosystem } : {})
    const summaries: LibrarySummary[] = []
    const indexed: { library: LibraryRecord; versions: LibraryVersionRecord[] }[] = []
    for (const library of records) {
      // oxlint-disable-next-line no-await-in-loop -- one library after another keeps the store calm
      const versions = await libraries.listVersions(library)
      indexed.push({ library, versions })
      summaries.push({
        ecosystem: library.ecosystem,
        name: library.name,
        ...(library.description ? { description: library.description } : {}),
        ...(library.latest ? { latest: library.latest } : {}),
        ...(library.repository ? { repository: library.repository.url } : {}),
        versions: versions.filter((version) => version.roles.length).map((v) => v.version),
        repos: new Set(versions.flatMap((version) => version.usedBy)).size,
        chunks: stats.get(`${library.ecosystem}:${library.name}`)?.chunks ?? 0,
        issues: stats.get(`${library.ecosystem}:${library.name}`)?.issues ?? 0,
        failed: failedSources(library, versions),
        updatedAt: library.updatedAt,
      })
    }
    const progress = on ? await libraryProgress(store.kv) : undefined
    return c.json<LibraryIndexStatus>({
      libraries: summaries,
      ...(lastRun ? { lastRun } : {}),
      enabled: on,
      ...(progress ? { progress } : {}),
      coverage: librarySourceCoverage(indexed),
    })
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

  routes.get('/system/library-index/github', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const days = Math.min(90, Math.max(1, Math.trunc(Number(c.req.query('days') ?? 30)) || 30))
    const settings = await librariesConfigOf(store.settings)
    return c.json<GitHubTokenUsage>(
      await githubTokenUsage({
        credentials: await resolveGitHubTokens(deps.credentials, settings?.github),
        usage: githubUsageFor(store.kv),
        days,
        now: deps.now,
        info: cachedInfo,
      }),
    )
  })

  routes.post('/system/library-index/reindex', async (c) => {
    authorize(c, 'analyses:run', GLOBAL)
    if (!store.libraries)
      throw new HTTPException(503, { message: 'the store keeps no library index' })
    if (!(await enabled()))
      throw new HTTPException(409, { message: 'library indexing is off (setting `libraries`)' })
    if (!store.kv) throw new HTTPException(503, { message: 'the store keeps no key-value state' })
    return c.json<LibraryReindexResult>({ started: await requestLibraryIndex(store.kv) })
  })

  return routes
}
