import { type Principal, can, scopeCoversRepo } from '@holtkeeper/access'
import type {
  DependencyApiChange,
  DependencyDetail,
  DependencyRepo,
  DependencyRow,
  DependencyTable,
  DependencyUpgrade,
  LibrarySearchResult,
} from '@holtkeeper/api'
import { type ApiPackage, type ApiChange, diffPackage } from '@holtkeeper/api-surface'
import { compareVersions, latestDepgraphs } from '@holtkeeper/depgraph'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type LatestVersion,
  latestVersions,
  majorsBehind,
  sameVersion,
} from '@holtkeeper/libraries'
import type { LibraryChunk, LibraryEcosystem, LibraryRef } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import { type UsageIndex, impactOfChanges } from '../api-surface/usages.ts'
import { type AppContext, type Env, type ServerDeps, principalOf, repoTarget } from '../context.ts'
import {
  type LibraryUsers,
  advisoriesByLibrary,
  bundleShares,
  groupUses,
  libraryDecisions,
  libraryKeyOf,
  licenseSightings,
  licensesOf,
  mergeRequestsOf,
  newestAuditFindings,
  renovateMergeRequests,
  renovateState,
  versionSpread,
  worstSeverity,
  worstVerdict,
} from '../dependencies.ts'
import { fleetLibraryUses } from '../libraries.ts'
import type { LibraryIndex } from '../tools/libraries.ts'
import { type CatalogReach, canReadShared, canSee, scopeOwner } from '../visibility.ts'

const GLOBAL = { kind: 'global' } as const
const DOCUMENT_CHUNKS = 100_000

/** What the dependency routes share with the API catalog and the MCP endpoint. */
export interface DependencyRouteContext {
  catalog: ApiCatalog
  usages: UsageIndex
  /** What of the catalog the principal may read. */
  reach: (principal: Principal) => Promise<CatalogReach>
  /** The library index as a principal reading `canRead` sees it; `undefined` without one. */
  libraryIndex: (principal: Principal, canRead: RepoFilter) => LibraryIndex | undefined
}

const ecosystemParam = (value: string | undefined): LibraryEcosystem => {
  if (value === 'npm') return 'npm'
  if (value?.toLowerCase() === 'go') return 'Go'
  throw new HTTPException(400, { message: 'ecosystem must be npm or Go' })
}

const refParam = (c: AppContext): LibraryRef => {
  const name = c.req.query('name')?.trim()
  if (!name) throw new HTTPException(400, { message: 'name is required' })
  return { ecosystem: ecosystemParam(c.req.query('ecosystem')), name }
}

const parseKey = (key: string): RepoRef => {
  const separator = key.indexOf(':')
  return { forge: key.slice(0, separator), path: key.slice(separator + 1) }
}

const behindOf = (users: LibraryUsers, latest: string | undefined) => {
  if (!latest) return { majorsBehind: 0, reposBehind: 0 }
  let most = 0
  let repos = 0
  for (const versions of users.repos.values()) {
    const behind = Math.max(0, ...versions.map((version) => majorsBehind(version, latest)))
    most = Math.max(most, behind)
    if (behind > 0) repos += 1
  }
  return { majorsBehind: most, reposBehind: repos }
}

/**
 * The Dependencies page API: `GET /dependencies` (library table), `GET /dependencies/library`
 * (Overview and Docs of one library), `GET /dependencies/upgrade` (Upgrade tab) and `GET
 * /dependencies/docs` (docs search). Everything is limited to the caller's catalog reach
 * (`canSeeCatalog`; call sites `canSeeSnippets`, advisories `audits:read`, decisions
 * `knowledge:read` or `shared`) and reads stored records, the library index and its latest
 * versions only: nothing reaches a forge, a registry or a model.
 */
export function dependencyRoutes(deps: ServerDeps, context: DependencyRouteContext) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const latestStore = store.kv ? latestVersions(store.kv) : undefined

  const view = async (principal: Principal) => {
    const scope = await context.reach(principal)
    const canRead = scope.catalog
    const fleet = await fleetLibraryUses(store.analyses, {
      accept: canRead,
      usages: context.usages,
      catalog: context.catalog,
    })
    const latest = (await latestStore?.all()) ?? new Map<string, LatestVersion>()
    const latestOf = (key: string) =>
      fleet.internal.has(key) ? fleet.defined.get(key) : latest.get(key)?.latest
    return { scope, canRead, fleet, libraries: groupUses(fleet.uses), latest, latestOf }
  }

  const canReadAudits = (principal: Principal) => (repo: RepoRef) =>
    canSee(principal, 'audits:read', repoTarget(config, repo))
  const canReadAnalyses = (principal: Principal) => (repo: RepoRef) =>
    canSee(principal, 'analyses:read', repoTarget(config, repo))

  app.get('/dependencies', async (c) => {
    const principal = principalOf(c)
    const { canRead, fleet, libraries, latestOf } = await view(principal)
    const [depgraphs, findings, { libraries: licenses }, renovate] = await Promise.all([
      latestDepgraphs(store.analyses, { accept: (record) => canRead(record.repo) }),
      newestAuditFindings(store.auditRuns, canReadAudits(principal)),
      licenseSightings(store.analyses, canReadAnalyses(principal)),
      renovateMergeRequests(store.analyses, canReadAnalyses(principal)),
    ])
    const advisories = advisoriesByLibrary(findings)

    const counts = new Map<string, number>()
    for (const users of libraries.values())
      for (const repo of users.repos.keys()) counts.set(repo, (counts.get(repo) ?? 0) + 1)
    const repos = new Map<string, DependencyRepo>()
    const repoEntry = (repo: RepoRef) => ({
      repo,
      groups: repoTarget(config, repo).groups,
      dependencies: counts.get(`${repo.forge}:${repo.path}`) ?? 0,
    })
    for (const [key, { record }] of depgraphs)
      repos.set(key, {
        ...repoEntry(record.repo),
        analysisId: record.id,
        ...(record.ref ? { ref: record.ref } : {}),
        createdAt: record.createdAt,
      })
    for (const key of counts.keys()) if (!repos.has(key)) repos.set(key, repoEntry(parseKey(key)))

    const rows = [...libraries].map(([key, users]): DependencyRow => {
      const latest = latestOf(key)
      const found = advisories.get(key) ?? []
      const severity = worstSeverity(found)
      const sightings = licenses.get(key) ?? []
      const verdict = worstVerdict(sightings)
      return {
        ecosystem: users.ref.ecosystem,
        name: users.ref.name,
        internal: fleet.internal.has(key),
        usedBy: [...users.repos].map(([repo, versions]) => ({ repo, versions })),
        versions: versionSpread(users, latest),
        ...(latest ? { latest } : {}),
        ...behindOf(users, latest),
        advisories: { count: found.length, ...(severity ? { severity } : {}) },
        licenses: [...new Set(sightings.map(({ pkg }) => pkg.licenses.join(' AND ')))]
          .filter(Boolean)
          .toSorted(),
        ...(verdict ? { licenseVerdict: verdict } : {}),
        renovate: renovateState(renovate, key),
      }
    })
    rows.sort(
      (a, b) =>
        Number(a.internal) - Number(b.internal) ||
        b.majorsBehind - a.majorsBehind ||
        b.advisories.count - a.advisories.count ||
        b.usedBy.length - a.usedBy.length ||
        a.name.localeCompare(b.name),
    )
    const thirdParty = rows.filter((row) => !row.internal)
    return c.json<DependencyTable>({
      repos: [...repos.values()].toSorted((a, b) =>
        `${a.repo.forge}:${a.repo.path}`.localeCompare(`${b.repo.forge}:${b.repo.path}`),
      ),
      libraries: rows,
      totals: {
        libraries: thirdParty.length,
        internal: rows.length - thirdParty.length,
        behindMajor: thirdParty.filter((row) => row.majorsBehind > 0).length,
        withAdvisories: thirdParty.filter((row) => row.advisories.count > 0).length,
        renovateOpen: rows.filter((row) => row.renovate === 'open').length,
        renovateBroken: rows.filter((row) => row.renovate === 'broken').length,
      },
    })
  })

  app.get('/dependencies/library', async (c) => {
    const principal = principalOf(c)
    const ref = refParam(c)
    const key = libraryKeyOf(ref)
    const { scope, canRead, fleet, libraries, latest, latestOf } = await view(principal)
    const users = libraries.get(key)
    const index = context.libraryIndex(principal, canRead)
    const record = await index?.store.getLibrary(ref)
    if (!users && !(record && can(principal, 'analyses:read', GLOBAL)))
      throw new HTTPException(404, { message: `no repository you can read uses ${ref.name}` })
    const versions = (await index?.store.listVersions(ref)) ?? []
    const newest = versions.find((version) => version.roles.length) ?? versions[0]
    const documents = new Map<
      string,
      { source: LibraryChunk['source']; path: string; chunks: number }
    >()
    if (newest && index)
      for (const chunk of await index.store.listChunks(
        { ...ref, version: newest.version },
        DOCUMENT_CHUNKS,
      )) {
        const entry = documents.get(`${chunk.source}\u0000${chunk.path}`) ?? {
          source: chunk.source,
          path: chunk.path,
          chunks: 0,
        }
        entry.chunks += 1
        documents.set(`${chunk.source}\u0000${chunk.path}`, entry)
      }

    const knowledgeRepos = [...(users?.repos.keys() ?? [])]
      .map((origin) => repoTarget(config, parseKey(origin)))
      .filter((target) => canSee(principal, 'knowledge:read', target))
    const [findings, sightings, bundles, renovate, decisions] = await Promise.all([
      newestAuditFindings(store.auditRuns, canReadAudits(principal)),
      licenseSightings(store.analyses, canReadAnalyses(principal)),
      ref.ecosystem === 'npm'
        ? bundleShares(store.analyses, canReadAnalyses(principal), ref.name)
        : [],
      renovateMergeRequests(store.analyses, canReadAnalyses(principal)),
      libraryDecisions(
        store.knowledge,
        {
          canRead: (entry) =>
            can(principal, 'knowledge:read', { kind: 'scope', scope: entry.scope }) ||
            knowledgeRepos.some((target) => scopeCoversRepo(entry.scope, target)),
          canReadShared: (entry) => canReadShared(principal, entry.scope, scope.policy),
          ownerOf: (entry) => scopeOwner(entry.scope, (repo) => repoTarget(config, repo).groups),
        },
        ref,
      ),
    ])
    const newestRelease = latestOf(key)
    const checked = fleet.internal.has(key) ? undefined : latest.get(key)
    return c.json<DependencyDetail>({
      ecosystem: ref.ecosystem,
      name: ref.name,
      internal: fleet.internal.has(key),
      ...(newestRelease ? { latest: newestRelease } : {}),
      ...(checked ? { latestCheckedAt: checked.checkedAt } : {}),
      ...(record?.description ? { description: record.description } : {}),
      ...(record?.homepage ? { homepage: record.homepage } : {}),
      ...(record?.repository ? { repository: record.repository.url } : {}),
      usedBy: [...(users?.repos ?? [])].map(([origin, used]) => {
        const repo = parseKey(origin)
        return {
          repo,
          groups: repoTarget(config, repo).groups,
          versions: used,
          majorsBehind: newestRelease
            ? Math.max(0, ...used.map((version) => majorsBehind(version, newestRelease)))
            : 0,
        }
      }),
      versions: users ? versionSpread(users, newestRelease) : [],
      indexed: versions
        .filter((version) => version.roles.length)
        .map((version) => ({
          version: version.version,
          roles: version.roles,
          ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
          ...(version.deprecated ? { deprecated: version.deprecated } : {}),
        })),
      advisories: advisoriesByLibrary(findings).get(key) ?? [],
      licenses: licensesOf(sightings.libraries.get(key) ?? []),
      bundles,
      decisions,
      mergeRequests: mergeRequestsOf(renovate, key),
      docs: {
        ...(newest ? { version: newest.version } : {}),
        documents: [...documents.values()].toSorted(
          (a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path),
        ),
      },
    })
  })

  app.get('/dependencies/upgrade', async (c) => {
    const principal = principalOf(c)
    const ref = refParam(c)
    const key = libraryKeyOf(ref)
    const { scope, canRead, fleet, libraries, latestOf } = await view(principal)
    const users = libraries.get(key)
    if (!users)
      throw new HTTPException(404, { message: `no repository you can read uses ${ref.name}` })
    const used = [...new Set([...users.repos.values()].flat())].toSorted(compareVersions)
    const from = c.req.query('from')?.trim() || used[0]
    const to = c.req.query('to')?.trim() || latestOf(key)
    const notes: string[] = []
    const result: DependencyUpgrade = {
      ...ref,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      notes,
    }
    if (!from || !to) {
      notes.push('The latest version is not known yet; it comes with the next library index run.')
      return c.json<DependencyUpgrade>(result)
    }

    let diff: { before: ApiPackage | undefined; changes: ApiChange[] } | undefined
    if (fleet.internal.has(key)) {
      const found = await context.catalog.diff(canRead, ref.name, { from, to })
      if (found) {
        const old = await context.catalog.resolve(canRead, ref.name, {
          version: found.from.analysisId,
          repo: `${found.repo.forge}:${found.repo.path}`,
        })
        diff = { before: old?.package, changes: found.diff.changes }
      } else notes.push(`The API catalog has no two versions of ${ref.name} to compare.`)
    } else {
      const index = context.libraryIndex(principal, canRead)
      if (!index) notes.push('The server keeps no library index.')
      else if (!(await index.store.getLibrary(ref)))
        notes.push(`${ref.name} is not in the library index.`)
      else {
        result.changes = await index.docs.changes({
          package: ref.name,
          ecosystem: ref.ecosystem,
          from,
          to,
        })
        const withApi = await index.api.versions(ref)
        const fromVersion = withApi.find((version) => sameVersion(version, from))
        const toVersion = withApi.find((version) => sameVersion(version, to))
        if (!fromVersion || !toVersion)
          notes.push(
            `No indexed API for ${[fromVersion ? undefined : from, toVersion ? undefined : to].filter(Boolean).join(' and ')}; indexed: ${withApi.join(', ') || 'none'}.`,
          )
        else {
          const [before, after] = await Promise.all([
            index.api.get(ref, fromVersion),
            index.api.get(ref, toVersion),
          ])
          const names = [...new Set([...(before ?? []), ...(after ?? [])].map((pkg) => pkg.name))]
          diff = {
            before: before?.find((pkg) => pkg.name === ref.name) ?? before?.[0],
            changes: names.flatMap(
              (pkgName) =>
                diffPackage(
                  before?.find((pkg) => pkg.name === pkgName),
                  after?.find((pkg) => pkg.name === pkgName),
                ).changes,
            ),
          }
        }
      }
    }

    if (diff) {
      result.api = diff.changes.flatMap((change): DependencyApiChange[] =>
        change.change === 'added'
          ? []
          : [
              {
                change: change.change,
                subpath: change.subpath,
                name: change.name,
                kind: change.kind,
                ...(change.before ? { before: change.before } : {}),
                ...(change.after ? { after: change.after } : {}),
              },
            ],
      )
      if (ref.ecosystem === 'npm')
        result.impact = await impactOfChanges(context.usages, scope.snippets, ref.name, {
          before: diff.before,
          changes: diff.changes,
          target: to,
        })
      else notes.push('Call sites are indexed for npm packages only; see the API changes.')
    }
    return c.json<DependencyUpgrade>(result)
  })

  app.get('/dependencies/docs', async (c) => {
    const principal = principalOf(c)
    const index = context.libraryIndex(principal, (await context.reach(principal)).catalog)
    const text = c.req.query('q')?.trim() ?? ''
    if (!index || !text) return c.json<LibrarySearchResult>({ hits: [] })
    const ecosystem = c.req.query('ecosystem')
    const name = c.req.query('name')
    const version = c.req.query('version')
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100)
    const hits = await index.store.searchChunks(
      text,
      {
        ...(ecosystem ? { ecosystem: ecosystemParam(ecosystem) } : {}),
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
      },
      limit,
    )
    return c.json<LibrarySearchResult>({ hits })
  })

  return app
}
