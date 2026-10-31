import type { Principal } from '@holtkeeper/access'
import type {
  PackageUsageView,
  PublishedPackagesView,
  RepoUsageView,
  UpgradeImpactView,
  UsageSitesView,
} from '@holtkeeper/api'
import {
  type UsedExport,
  findSites,
  isUsageKind,
  packageUsage,
  repoPackages,
  usageKinds,
  usedByCounts,
} from '@holtkeeper/usages'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import { type UsageIndex, impactOf } from '../api-surface/usages.ts'
import { type AppContext, type Env, principalOf } from '../context.ts'

const required = (c: AppContext, name: string) => {
  const value = c.req.query(name)
  if (!value) throw new HTTPException(400, { message: `${name} is required` })
  return value
}

const optional = (c: AppContext, name: string) => c.req.query(name) || undefined

const withoutSites = (item: UsedExport): Omit<UsedExport, 'sites' | 'truncated'> => ({
  name: item.name,
  subpath: item.subpath,
  count: item.count,
  files: item.files,
  kinds: item.kinds,
  members: item.members,
  props: item.props,
  spread: item.spread,
})

/**
 * Routes under `/api/api-surface/usages` over the newest `usages` record of every readable
 * repository: who uses a package and which parts, the sites with snippets, what one repository
 * uses, how much the packages one repository defines are used, and what upgrading a package
 * affects.
 */
export function usageRoutes(options: {
  catalog: ApiCatalog
  usages: UsageIndex
  readable: (principal: Principal) => RepoFilter
}) {
  const { catalog, usages, readable } = options
  const routes = new Hono<Env>()

  routes.get('/api-surface/usages/package', async (c) => {
    const filter = readable(principalOf(c))
    const name = required(c, 'name')
    const records = await usages.records(filter)
    const byOrigin = new Map(
      records.map((record) => [`${record.repo.forge}:${record.repo.path}`, record]),
    )
    const usage = packageUsage(
      records.map((record) => ({ origin: record.repo, data: record.data })),
      name,
    )
    const indexedAt = usages.indexedAt()
    return c.json<PackageUsageView>({
      name,
      versions: usage.versions,
      repos: usage.repos.flatMap((repo) => {
        const record = byOrigin.get(`${repo.origin.forge}:${repo.origin.path}`)
        if (!record) return []
        return [
          {
            repo: repo.origin,
            analysisId: record.id,
            analyzedAt: record.createdAt,
            ...(record.ref ? { ref: record.ref } : {}),
            versions: repo.versions,
            ranges: repo.ranges,
            workspaces: repo.workspaces,
            count: repo.count,
            files: repo.files,
            exports: repo.exports.map(withoutSites),
          },
        ]
      }),
      exports: usage.exports,
      ...(indexedAt ? { indexedAt } : {}),
    })
  })

  routes.get('/api-surface/usages/sites', async (c) => {
    const filter = readable(principalOf(c))
    const kind = optional(c, 'kind')
    if (kind && !isUsageKind(kind))
      throw new HTTPException(400, { message: `kind must be one of ${usageKinds.join(', ')}` })
    const repo = optional(c, 'repo')
    const records = await usages.records(filter)
    const name = required(c, 'package')
    const exported = optional(c, 'export')
    const member = optional(c, 'member')
    const prop = optional(c, 'prop')
    const found = findSites(
      records.map((record) => ({ origin: record.repo, data: record.data })),
      {
        package: name,
        ...(exported ? { export: exported } : {}),
        ...(member ? { member } : {}),
        ...(prop ? { prop } : {}),
        ...(kind && isUsageKind(kind) ? { kind } : {}),
        ...(repo
          ? { origins: records.map((r) => r.repo).filter((r) => `${r.forge}:${r.path}` === repo) }
          : {}),
        limit: Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200),
      },
    )
    return c.json<UsageSitesView>(found)
  })

  routes.get('/api-surface/usages/repo', async (c) => {
    const filter = readable(principalOf(c))
    const origin = required(c, 'repo')
    const record = await usages.record(filter, origin)
    if (!record) throw new HTTPException(404, { message: `no usage record of ${origin}` })
    return c.json<RepoUsageView>({
      repo: record.repo,
      analysisId: record.id,
      analyzedAt: record.createdAt,
      files: record.data.files,
      types: record.data.types,
      packages: repoPackages(record.data),
    })
  })

  routes.get('/api-surface/usages/published', async (c) => {
    const filter = readable(principalOf(c))
    const origin = required(c, 'repo')
    const defined = await catalog.packages(
      (repo) => `${repo.forge}:${repo.path}` === origin && filter(repo),
    )
    const records = await usages.records(filter)
    const counts = usedByCounts(
      records.map((record) => ({ origin: record.repo, data: record.data })),
      defined.map((pkg) => pkg.name),
    )
    return c.json<PublishedPackagesView>({
      packages: defined
        .map((pkg) => ({
          name: pkg.name,
          ...(pkg.version ? { version: pkg.version } : {}),
          ...(pkg.description ? { description: pkg.description } : {}),
          private: pkg.private,
          dir: pkg.dir,
          exports: pkg.exports,
          ...(counts.get(pkg.name) ?? { repos: 0, count: 0, files: 0 }),
        }))
        .toSorted((a, b) => b.repos - a.repos || b.count - a.count || a.name.localeCompare(b.name)),
    })
  })

  routes.get('/api-surface/usages/impact', async (c) => {
    const filter = readable(principalOf(c))
    const name = required(c, 'package')
    const from = optional(c, 'from')
    const to = optional(c, 'to')
    const repo = optional(c, 'repo')
    const result = await impactOf(catalog, usages, filter, name, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(repo ? { repo } : {}),
    })
    if (!result) throw new HTTPException(404, { message: `no two versions of ${name} to compare` })
    const records = await usages.records(filter)
    const refOf = new Map(records.map((r) => [`${r.repo.forge}:${r.repo.path}`, r.repo]))
    const toRef = (origin: string) =>
      refOf.get(origin) ?? {
        forge: origin.split(':')[0] ?? '',
        path: origin.slice(origin.indexOf(':') + 1),
      }
    return c.json<UpgradeImpactView>({
      repo: result.repo,
      from: result.from,
      to: result.to,
      impact: {
        package: result.impact.package,
        affected: result.impact.affected.map(toRef),
        unaffected: result.impact.unaffected.map(toRef),
        items: result.impact.items.map((item) => ({
          ...item,
          repos: item.repos.map((repoImpact) => ({
            ...repoImpact,
            origin: toRef(repoImpact.origin),
          })),
        })),
      },
    })
  })

  return routes
}
