import {
  type Principal,
  type RepoTarget,
  type TeamPatternsByKey,
  can,
  scopeWithin,
} from '@holtkeeper/access'
import { globMatches } from '@holtkeeper/access/paths'
import { type HoltkeeperConfig, fleetPatterns } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { type GuideRequest, type RepoSignals, repoNeighbours } from '@holtkeeper/guide'
import type { KnowledgeNeighbour } from '@holtkeeper/knowledge'
import type { CrossTeamCatalog } from '@holtkeeper/settings'
import {
  type AnalysisStore,
  type Family,
  type KnowledgeEntry,
  type Store,
  newestRecords,
} from '@holtkeeper/store'
import { usagesDataSchema } from '@holtkeeper/usages'

import type { UsageIndex } from './api-surface/usages.ts'
import { repoTarget } from './context.ts'
import { canReadShared, crossTeamPolicy, isSharedEntry } from './visibility.ts'

interface StackShape {
  components?: { kind?: unknown; id?: unknown; usages?: { repo?: unknown }[] }[]
}

/** Runtimes and package managers per `forge:path`, from the newest `stack` records. */
async function toolchains(analyses: AnalysisStore): Promise<Map<string, string[]>> {
  const found = await newestRecords(analyses, 'stack', (record) =>
    typeof record.data === 'object' && record.data !== null
      ? (record.data as StackShape)
      : undefined,
  )
  const result = new Map<string, Set<string>>()
  for (const { record, value } of found.values())
    for (const component of value.components ?? []) {
      if (component.kind !== 'runtime' && component.kind !== 'package-manager') continue
      if (typeof component.id !== 'string') continue
      for (const usage of component.usages ?? []) {
        if (typeof usage.repo !== 'string') continue
        const key = `${record.repo.forge}:${usage.repo}`
        result.set(key, (result.get(key) ?? new Set()).add(component.id))
      }
    }
  return new Map([...result].map(([key, ids]) => [key, [...ids]]))
}

/**
 * What family suggestions and repository neighbours compare (`RepoSignals`), from stored records
 * only: the direct third-party dependency names of each repository's newest `usages` record (its
 * own packages left out) and the runtimes and package managers of the newest `stack` records.
 * `usages` reuses a loaded usage index; without it the records are read here.
 */
export async function repoSignals(
  analyses: AnalysisStore,
  usages?: Pick<UsageIndex, 'entries'>,
): Promise<RepoSignals[]> {
  const [entries, tools] = await Promise.all([
    usages
      ? usages.entries(() => true)
      : newestRecords(analyses, 'usages', (record) => {
          const parsed = usagesDataSchema.safeParse(record.data)
          return parsed.success ? parsed.data : undefined
        }).then((found) => [...found].map(([origin, { value }]) => ({ origin, data: value }))),
    toolchains(analyses),
  ])
  return entries.map((entry) => ({
    repo: entry.origin,
    dependencies: entry.data.packages.filter((pkg) => !pkg.local).map((pkg) => pkg.name),
    toolchain: tools.get(entry.origin) ?? [],
  }))
}

/** Whether `repo` is in the fleet of its forge: a configured forge, an include matches, no exclude does. */
export function inFleet(config: HoltkeeperConfig, repo: RepoRef): boolean {
  if (!config.forges[repo.forge]) return false
  const { include, exclude } = fleetPatterns(config, repo.forge)
  return (
    include.some((pattern) => globMatches(pattern, repo.path)) &&
    !exclude.some((pattern) => globMatches(pattern, repo.path))
  )
}

/** How long signals and families are kept before they are read again. */
const NEIGHBOURS_TTL_MS = 10 * 60_000

/** Repositories like a given one, for knowledge they may share. */
export interface NeighbourIndex {
  /**
   * The fleet repositories most like `repo` (`repoNeighbours`: the family similarity, at most 5,
   * at least 0.5, members of its own family left out) with their owner teams and family id; none
   * when `repo` is not in the fleet or has no signals.
   */
  neighboursOf(repo: RepoRef): Promise<KnowledgeNeighbour[]>
}

const refOf = (key: string): RepoRef | undefined => {
  const split = key.indexOf(':')
  return split < 1 ? undefined : { forge: key.slice(0, split), path: key.slice(split + 1) }
}

/**
 * A `NeighbourIndex` over the stored signals (`repoSignals`) of fleet repositories (`inFleet`)
 * and the confirmed families, read at most every `ttlMs` (default `NEIGHBOURS_TTL_MS`); a failed
 * read is retried on the next call. Owner teams come from the live config on every call.
 */
export function createNeighbourIndex(deps: {
  store: Pick<Store, 'analyses' | 'families'>
  config: HoltkeeperConfig
  ttlMs?: number
  now?: () => number
}): NeighbourIndex {
  const ttl = deps.ttlMs ?? NEIGHBOURS_TTL_MS
  const now = deps.now ?? Date.now
  let cached:
    | { at: number; load: Promise<{ signals: RepoSignals[]; families: Family[] }> }
    | undefined
  const load = () => {
    if (cached && now() - cached.at < ttl) return cached.load
    const pending = Promise.all([
      repoSignals(deps.store.analyses),
      deps.store.families.list(),
    ]).then(([signals, families]) => ({ signals, families }))
    const entry = { at: now(), load: pending }
    cached = entry
    pending.catch(() => {
      if (cached === entry) cached = undefined
    })
    return pending
  }
  return {
    async neighboursOf(repo) {
      if (!inFleet(deps.config, repo)) return []
      const { signals, families } = await load()
      const fleet = signals.filter((signal) => {
        const ref = refOf(signal.repo)
        return ref !== undefined && inFleet(deps.config, ref)
      })
      return repoNeighbours(fleet, `${repo.forge}:${repo.path}`, { families }).flatMap(
        (neighbour) => {
          const ref = refOf(neighbour.repo)
          if (!ref) return []
          const family = families.find((f) => f.members.includes(neighbour.repo))?.id
          return [
            {
              repo: repoTarget(deps.config, ref),
              similarity: neighbour.similarity,
              ...(family !== undefined && { family }),
            },
          ]
        },
      )
    },
  }
}

const teamPatterns = (config: Pick<HoltkeeperConfig, 'teams'>): TeamPatternsByKey =>
  Object.fromEntries(
    Object.entries(config.teams).map(([key, team]) => [
      key,
      { owns: team.owns, exclude: team.exclude },
    ]),
  )

/**
 * Which knowledge of other repositories a task of `repo` may be shown. Team knowledge: an entry
 * whose scope lies within the repository's owner teams (`scopeWithin` with the teams' `owns`
 * patterns, so `acme/square/**` counts for a team owning `acme/**`) — what members of those
 * teams read anyway. Another team's entry only when it is in the cross-team catalog: accepted,
 * `shared`, and `policy` not `off`. An entry an agent works for a person on (`requester`, chat)
 * must also be readable by that person: `knowledge:read` over its scope, or a `shared` entry
 * within their catalog reach (`canReadShared`).
 */
export function neighbourReadable(input: {
  config: Pick<HoltkeeperConfig, 'teams'>
  repo: RepoTarget
  policy: CrossTeamCatalog
  requester?: Principal
}): (entry: KnowledgeEntry) => boolean {
  const teams = teamPatterns(input.config)
  const own = input.repo.teams
  const { requester, policy } = input
  return (entry) => {
    const shared = isSharedEntry(entry)
    const allowed =
      (own.length > 0 && scopeWithin(entry.scope, { teams: own }, teams)) ||
      (shared && policy !== 'off')
    if (!allowed || !requester) return allowed
    return (
      can(requester, 'knowledge:read', { kind: 'scope', scope: entry.scope }) ||
      (shared && canReadShared(requester, entry.scope, policy))
    )
  }
}

/**
 * The `neighbours` of a Guide request for a task of `repo`: its neighbours from `index` and the
 * access rule of `neighbourReadable` under the current `access.crossTeam`; `undefined` when it has
 * none or reading them fails (the Guide then goes without the block).
 */
export async function guideNeighbours(
  deps: {
    index: NeighbourIndex
    store: Pick<Store, 'settings'>
    config: Pick<HoltkeeperConfig, 'teams'>
    log?: (line: string) => void
  },
  repo: RepoTarget,
  requester?: Principal,
): Promise<GuideRequest['neighbours'] | undefined> {
  try {
    const repos = await deps.index.neighboursOf(repo)
    if (!repos.length) return undefined
    const policy = await crossTeamPolicy(deps.store.settings)
    return {
      repos,
      readable: neighbourReadable({
        config: deps.config,
        repo,
        policy,
        ...(requester && { requester }),
      }),
    }
  } catch (error) {
    deps.log?.(`neighbours: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
