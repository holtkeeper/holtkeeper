import {
  type Action,
  type Principal,
  type RepoTarget,
  can,
  leafGroups,
  outerGroups,
  scopeCoversRepo,
} from '@holtkeeper/access'
import { type RegistryToolset, ToolError, mountToolsets } from '@holtkeeper/agent-tools'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { RepoRef } from '@holtkeeper/forge'
import { type GuideResolver, familyOf } from '@holtkeeper/guide'
import { latestVersions, libraryApi } from '@holtkeeper/libraries'
import type { CrossTeamCatalog } from '@holtkeeper/settings'
import type { Family, Store } from '@holtkeeper/store'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import type { UsageIndex } from '../api-surface/usages.ts'
import { repoKey } from '../context.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import { repoDependencies, stackGroupViews } from '../stack.ts'
import { canReadShared, reachOf, scopeOwner } from '../visibility.ts'
import { type AssetToolsAccess, assetsToolset } from './assets.ts'
import { type CatalogToolsContext, catalogToolset } from './catalog.ts'
import { knowledgeToolset } from './knowledge.ts'
import { type LibraryIndex, libraryToolset } from './libraries.ts'
import { type OpsToolsAccess, opsToolset } from './ops.ts'
import { type ReleaseToolsAccess, releasesToolset } from './releases.ts'
import type { SupplyToolsAccess } from './repos.ts'
import { type RulesAccess, type TestIdsSnapshot, rulesToolset } from './rules.ts'
import { type StackToolsContext, stackToolset } from './stack.ts'
import { type TaskToolsAccess, tasksToolset } from './tasks.ts'

/** Toolsets the MCP endpoint serves, in the order clients list them. */
const MCP_TOOLSETS = [
  'catalog',
  'stack',
  'knowledge',
  'rules',
  'assets',
  'libraries',
  'releases',
  'ops',
  'tasks',
]

/** Toolsets every internal task mounts. */
const BASE_TOOLSETS = ['code', 'docs', 'knowledge', 'libraries']

/**
 * Extra toolsets by task kind; tool schemas cost prompt tokens, so tasks mount only what they use.
 * One-shot kinds mount none, so they stay off the agent tool loop.
 * `rules` serves related repositories' rules and test ids: the task's own Guide is already its context.
 * Chat replies run without a checkout, so they mount no `code` or `docs`.
 */
const TASK_TOOLSETS: Record<string, readonly string[]> = {
  review: [...BASE_TOOLSETS, 'catalog', 'stack', 'assets'],
  chat: ['knowledge', 'libraries', 'catalog', 'stack', 'rules', 'assets', 'releases', 'ops'],
  'chat-summary': [],
  learning: [],
  guide: [],
  'release-notes': [],
  'library-digest': [],
  'knowledge-bootstrap': [],
}

/** Names of the toolsets an internal task of `taskKind` mounts, in mount order. */
export function taskToolsets(taskKind: string): readonly string[] {
  return TASK_TOOLSETS[taskKind] ?? BASE_TOOLSETS
}

/** What the MCP toolsets read for one caller. */
export interface McpToolsetsContext extends Omit<CatalogToolsContext, 'library'>, RulesAccess {
  /** The third-party library index; without it the `libraries` toolset is not offered. */
  library?: LibraryIndex
  /** Release state and steps; without it the `releases` toolset is not offered. */
  releases?: ReleaseToolsAccess
  /** Jobs, logs and budgets; without it the `ops` toolset is not offered. */
  ops?: OpsToolsAccess
  /** Asset policies and assets records; without it the `assets` toolset is not offered. */
  assets?: AssetToolsAccess
  /** Agent tasks; without it the `tasks` toolset is not offered. */
  tasks?: TaskToolsAccess
}

/**
 * The toolsets the MCP endpoint serves to one caller: `catalog`, `stack` (with `stack`), `knowledge`, `rules` (with any
 * of `guide`, `proposals`, `commits`, `testIds`), `assets` (with `assets`), `libraries` (with `library`), `releases`
 * (with `releases`), `ops` (with `ops`) and `tasks` (with `tasks`), every one limited by the caller's grants.
 */
export function mcpToolsets(context: McpToolsetsContext): RegistryToolset[] {
  const { library, releases, ops, assets, tasks } = context
  const rules = rulesToolset(context)
  return mountToolsets(
    [
      catalogToolset(context),
      ...(context.stack ? [stackToolset(context.stack)] : []),
      knowledgeToolset(context.knowledge),
      ...(rules ? [rules] : []),
      ...(assets ? [assetsToolset(assets)] : []),
      ...(library ? [libraryToolset(library, context.canRead)] : []),
      ...(releases ? [releasesToolset(releases)] : []),
      ...(ops ? [opsToolset(ops)] : []),
      ...(tasks ? [tasksToolset(tasks)] : []),
    ],
    MCP_TOOLSETS,
  )
}

/**
 * The `stack` tools over stored stack and depgraph records, limited to `canRead`; convention
 * problems are quoted only for `canDetail` repositories.
 */
export const storedStackTools = (
  analyses: Pick<Store['analyses'], 'latest' | 'list'>,
  access: {
    canRead: RepoFilter
    canDetail: RepoFilter
    groupsOf: (repo: RepoRef) => string[]
    /** How a group key is named in tool output; default the key itself. */
    groupLabel?: (key: string) => string
  },
): StackToolsContext => ({
  views: () =>
    stackGroupViews(analyses, {
      canRead: access.canRead,
      canFix: () => false,
      canDetail: access.canDetail,
      groupsOf: access.groupsOf,
    }),
  ownerOf: (repo) => {
    const groups = leafGroups(access.groupsOf(repo))
    return access.groupLabel ? groups.map(access.groupLabel) : groups
  },
  dependencies: async (repo) => (access.canRead(repo) ? repoDependencies(analyses, repo) : []),
})

/** Inputs of `agentCatalogContext`. */
export interface AgentCatalogOptions {
  catalog: ApiCatalog
  usages: UsageIndex
  store: Pick<Store, 'analyses' | 'auditRuns' | 'knowledge' | 'libraries'> &
    Partial<Pick<Store, 'audit' | 'kv' | 'settings'>>
  /** The repository the task works on. */
  repo: RepoTarget
  /** A repository with its config groups. */
  targetOf: (repo: RepoRef) => RepoTarget
  /** How a group key is named in tool output; default the key itself. */
  groupLabel?: (key: string) => string
  /** The `access.crossTeam` level. */
  policy: CrossTeamCatalog
  /** The person the task answers; their grants then bound what the agent reads. */
  requester?: Principal
  /** Where the library index keeps API surfaces; with it, third-party packages are covered too. */
  artifacts?: ArtifactStore
  /** Findings and licenses per asker (`supplyToolsAccess`); offered to a `requester` only. */
  supply?: (principal: Principal) => SupplyToolsAccess
  now: () => Date
}

/**
 * The `catalog` context of an internal agent working on `repo`, with the `stack` tools. Without a
 * `requester`, the agent reads every repository's packages, usages, stack and shared notes while
 * `policy` is not `off` (usage snippets only under `snippets`), and only repositories sharing a
 * group with `repo` when it is `off`. With a `requester` (chat), reach is exactly theirs:
 * `canSeeCatalog` and `canSeeSnippets` under `policy`. Audits and team-scoped knowledge stay
 * limited to `repo` (and the requester's `audits:read` and `knowledge:read`); with `supply`, a
 * requester also gets the fleet's findings and licenses exactly as the HTTP endpoints answer them.
 */
export function agentCatalogContext(options: AgentCatalogOptions): CatalogToolsContext {
  const { store, repo, artifacts, requester, policy, targetOf } = options
  const { settings } = store
  const key = repoKey(repo)
  const sameTeam = (other: RepoRef) =>
    repoKey(other) === key || targetOf(other).groups.some((group) => repo.groups.includes(group))
  const reach = requester ? reachOf(requester, policy, targetOf) : undefined
  const canRead: RepoFilter = reach ? reach.catalog : (other) => policy !== 'off' || sameTeam(other)
  const canReadSnippets: RepoFilter = reach
    ? reach.snippets
    : (other) => policy === 'snippets' || sameTeam(other)
  const groupsOf = (other: RepoRef) => targetOf(other).groups
  const label = options.groupLabel ?? ((group: string) => group)
  const ownerOf = (other: RepoRef) => leafGroups(groupsOf(other)).map(label)
  const canReadAnalyses: RepoFilter = (other) =>
    requester
      ? can(requester, 'analyses:read', { kind: 'repo', repo: targetOf(other) })
      : sameTeam(other)
  return {
    catalog: options.catalog,
    usages: options.usages,
    store,
    knowledge: {
      store,
      canReadScope: (scope) =>
        scopeCoversRepo(scope, repo) &&
        (!requester || can(requester, 'knowledge:read', { kind: 'scope', scope })),
      canReadShared: (scope) =>
        requester ? canReadShared(requester, scope, policy) : policy !== 'off',
      ownerOf: (scope) =>
        outerGroups(scopeOwner(scope, (other) => leafGroups(groupsOf(other)))).map(label),
      groupLabel: label,
      repoOf: (value) => (value === key ? repo : undefined),
      actor: 'agent',
      now: options.now,
    },
    canRead,
    canReadSnippets,
    canReadAnalyses,
    canReadAudits: (other) =>
      repoKey(other) === key &&
      (!requester || can(requester, 'audits:read', { kind: 'repo', repo: targetOf(other) })),
    ...(settings && { auditOff: () => analyzerOffFilter({ settings }, targetOf, 'audit') }),
    ownerOf,
    ...(store.kv ? { latest: latestVersions(store.kv) } : {}),
    stack: storedStackTools(store.analyses, {
      canRead,
      canDetail: canReadAnalyses,
      groupsOf,
      groupLabel: label,
    }),
    ...(requester && options.supply ? { supply: options.supply(requester) } : {}),
    ...(store.libraries && artifacts
      ? {
          library: {
            api: libraryApi({ store: store.libraries, artifacts }),
            store: store.libraries,
          },
        }
      : {}),
  }
}

/** Inputs of `agentRulesAccess`. */
export interface AgentRulesOptions {
  /** The repository the task works on. */
  repo: RepoTarget
  /** The person the task answers; rules then also need their `knowledge:read`, test ids their `analyses:read`. */
  requester?: Principal
  /** A configured repository by `forge:path`, with its groups; `undefined` for anything else. */
  targetOf: (repo: string) => RepoTarget | undefined
  resolve: GuideResolver
  testIds: (repo: RepoTarget) => Promise<TestIdsSnapshot>
  /** Confirmed families; a repository in the task repository's family is related like a teammate. */
  families: () => Promise<readonly Family[]>
}

/**
 * The `rules` access of an internal agent: `repo_rules` of other configured repositories that share
 * a group or a family with the task's repository, without team notes (its own Guide is already the task's
 * context, so asking for it is refused), and test ids of any configured repository. Internal agents
 * propose through the knowledge tools, not here.
 */
export function agentRulesAccess(options: AgentRulesOptions): RulesAccess {
  const own = repoKey(options.repo)
  const { requester } = options
  const allows = (action: Action, target: RepoTarget) =>
    !requester || can(requester, action, { kind: 'repo', repo: target })
  return {
    guide: {
      resolve: async (value, request) => {
        const target = options.targetOf(value)
        if (!target || !allows('knowledge:read', target)) return undefined
        if (repoKey(target) === own)
          throw new ToolError(
            "This repository's rules are already in your context; use repo_rules for other repositories.",
          )
        if (
          !target.groups.some((group) => options.repo.groups.includes(group)) &&
          !familyOf(await options.families(), own)?.members.includes(repoKey(target))
        )
          throw new ToolError(
            'repo_rules only serves repositories that share a team or a family with this repository.',
          )
        return options.resolve({ repo: target, ...request, notesChars: 0 })
      },
    },
    testIds: {
      testIds: async (value) => {
        const target = options.targetOf(value)
        return target && allows('analyses:read', target) ? options.testIds(target) : undefined
      },
    },
  }
}
