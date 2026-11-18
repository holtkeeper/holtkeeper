import {
  type Action,
  type Principal,
  type RepoTarget,
  can,
  scopeCoversRepo,
} from '@holtkeeper/access'
import { type RegistryToolset, ToolError, mountToolsets } from '@holtkeeper/agent-tools'
import type { McpToolsetName } from '@holtkeeper/api'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { RepoRef } from '@holtkeeper/forge'
import { type GuideResolver, familyOf } from '@holtkeeper/guide'
import { latestVersions, libraryApi } from '@holtkeeper/libraries'
import {
  REPORT_TOOL,
  type SecretReportsAccess,
  secretReportsToolset,
} from '@holtkeeper/secret-reports'
import type { CrossTeamCatalog } from '@holtkeeper/settings'
import type { Family, Store } from '@holtkeeper/store'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import type { UsageIndex } from '../api-surface/usages.ts'
import { repoKey } from '../context.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import { repoDependencies, stackTeamViews } from '../stack.ts'
import { canReadShared, reachOf, scopeOwner } from '../visibility.ts'
import { type AssetToolsAccess, assetsToolset } from './assets.ts'
import { type CatalogToolsContext, catalogToolset } from './catalog.ts'
import { knowledgeToolset } from './knowledge.ts'
import { type LibraryIndex, libraryToolset } from './libraries.ts'
import { type QaToolsAccess, qaToolset } from './qa.ts'
import type { SupplyToolsAccess } from './repos.ts'
import { type ReviewToolsAccess, reviewsToolset } from './reviews.ts'
import { type RulesAccess, type TestIdsSnapshot, rulesToolset } from './rules.ts'
import { type StackToolsContext, stackToolset } from './stack.ts'

/** Toolsets the MCP endpoint serves, in the order clients list them. */
const MCP_TOOLSETS = [
  'catalog',
  'stack',
  'knowledge',
  'rules',
  'assets',
  'libraries',
  'reviews',
  'qa',
  'security',
]

/**
 * The only tools that write which the MCP endpoint offers: two proposals people review before
 * agents rely on them, and secret reports administrators act on. Every other tool with
 * `readOnly: false` stays off MCP, so a new write tool is never exposed to people's clients by
 * accident.
 */
const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'propose_knowledge',
  'propose_rule_change',
  REPORT_TOOL,
])

/** Toolsets every internal task mounts. */
const BASE_TOOLSETS = ['code', 'docs', 'knowledge', 'libraries']

/**
 * Extra toolsets by task kind; tool schemas cost prompt tokens, so tasks mount only what they use.
 * One-shot kinds mount none, so they stay off the agent tool loop.
 * `rules` serves related repositories' rules and test ids: the task's own Guide is already its context.
 * Chat replies run without a checkout, so they mount no `code` or `docs`.
 * `git` (read-only history of the checkout) is for reviews, their thread replies and the
 * verification of their findings (`review-verify`). The verification checks a finding against the
 * checkout, so it skips the cross-repository `catalog` and `stack`, the largest schemas.
 */
const TASK_TOOLSETS: Record<string, readonly string[]> = {
  review: [...BASE_TOOLSETS, 'git', 'catalog', 'stack', 'assets'],
  'review-verify': [...BASE_TOOLSETS, 'git'],
  'review-plan': [],
  chat: ['knowledge', 'libraries', 'catalog', 'stack', 'rules', 'assets', 'releases', 'ops'],
  'chat-summary': [],
  learning: [],
  guide: [],
  'release-notes': [],
  'qa-notes': [],
  'security-triage': [],
  'library-digest': [],
  'knowledge-bootstrap': [],
  'knowledge-verify': [],
  translate: [],
}

/** Names of the toolsets an internal task of `taskKind` mounts, in mount order. */
export function taskToolsets(taskKind: string): readonly string[] {
  return TASK_TOOLSETS[taskKind] ?? BASE_TOOLSETS
}

/** What the MCP toolsets read for one caller. */
export interface McpToolsetsContext
  extends Omit<CatalogToolsContext, 'library' | 'supply'>, RulesAccess {
  /** The third-party library index; without it the `libraries` toolset is not offered. */
  library?: LibraryIndex
  /** Asset policies and assets records; without it the `assets` toolset is not offered. */
  assets?: AssetToolsAccess
  /** Merge request review state; without it the `reviews` toolset is not offered. */
  reviews?: ReviewToolsAccess
  /**
   * Secret reports of the caller; without it (feature off, or the caller chose `off`) the
   * `security` toolset is not offered.
   */
  secretReports?: SecretReportsAccess
  /** Releases › QA tasks; without it the `qa` toolset is not offered. */
  qa?: QaToolsAccess
  /**
   * The toggleable toolsets the caller's token serves; the others are not offered. Without it
   * (signed-in browsers reading the tool reference) every toolset is. Secret reports follow
   * `secretReports` instead.
   */
  toolsets?: readonly McpToolsetName[]
}

/**
 * The toolsets the MCP endpoint serves to one caller, picked for developers at work in one
 * repository: `catalog`, `stack` (with `stack`, `repo_stack` only), `knowledge`, `rules` (with any
 * of `guide`, `proposals`, `commits`, `testIds`, `releases`), `assets` (with `assets`), `libraries`
 * (with `library`), `reviews` (with `reviews`), `qa` (with `qa`) and `security` (with
 * `secretReports`), every one limited by the caller's grants and, but `security`, to the token's
 * `toolsets`. Fleet, operations and release tools stay with the web panel and chat. Tools that
 * write are left out unless `MCP_WRITE_TOOLS` names them; a toolset left without tools is not
 * offered.
 */
export function mcpToolsets(context: McpToolsetsContext): RegistryToolset[] {
  const { library, assets, reviews, secretReports, qa, toolsets } = context
  const rules = rulesToolset(context)
  const mounted = mountToolsets(
    [
      catalogToolset(context),
      ...(context.stack ? [stackToolset(context.stack, { fleet: false })] : []),
      knowledgeToolset(context.knowledge),
      ...(rules ? [rules] : []),
      ...(assets ? [assetsToolset(assets)] : []),
      ...(library ? [libraryToolset(library, context.canRead)] : []),
      ...(reviews ? [reviewsToolset(reviews)] : []),
      ...(qa ? [qaToolset(qa)] : []),
      ...(secretReports ? [secretReportsToolset(secretReports)] : []),
    ],
    toolsets
      ? MCP_TOOLSETS.filter(
          (name) => name === 'security' || toolsets.some((chosen) => chosen === name),
        )
      : MCP_TOOLSETS,
  )
  return mounted.flatMap((toolset) => {
    const tools = toolset.tools.filter(
      (tool) => tool.readOnly !== false || MCP_WRITE_TOOLS.has(tool.name),
    )
    return tools.length ? [{ ...toolset, tools }] : []
  })
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
    /** The owner teams of a repository. */
    teamsOf: (repo: RepoRef) => string[]
    /** How a team key is named in tool output; default the key itself. */
    teamLabel?: (key: string) => string
  },
): StackToolsContext => ({
  views: () =>
    stackTeamViews(analyses, {
      canRead: access.canRead,
      canFix: () => false,
      canDetail: access.canDetail,
      teamsOf: access.teamsOf,
    }),
  ownerOf: (repo) => {
    const teams = access.teamsOf(repo)
    return access.teamLabel ? teams.map(access.teamLabel) : teams
  },
  dependencies: async (repo) => (access.canRead(repo) ? repoDependencies(analyses, repo) : []),
})

/** Inputs of `agentCatalogContext`. */
export interface AgentCatalogOptions {
  catalog: ApiCatalog
  usages: UsageIndex
  store: Pick<Store, 'analyses' | 'knowledge' | 'libraries'> &
    Partial<Pick<Store, 'audit' | 'kv' | 'settings'>>
  /** The repository the task works on. */
  repo: RepoTarget
  /** A repository with its owner teams. */
  targetOf: (repo: RepoRef) => RepoTarget
  /** How a team key is named in tool output; default the key itself. */
  teamLabel?: (key: string) => string
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
 * an owner team with `repo` when it is `off`. With a `requester` (chat), reach is exactly theirs:
 * `canSeeCatalog` and `canSeeSnippets` under `policy`. Audits and team-scoped knowledge stay
 * limited to `repo` (and the requester's `audits:read` and `knowledge:read`); with `supply`, a
 * requester also gets the fleet's findings and licenses exactly as the HTTP endpoints answer them.
 */
export function agentCatalogContext(options: AgentCatalogOptions): CatalogToolsContext {
  const { store, repo, artifacts, requester, policy, targetOf } = options
  const { settings } = store
  const key = repoKey(repo)
  const sameTeam = (other: RepoRef) =>
    repoKey(other) === key || targetOf(other).teams.some((team) => repo.teams.includes(team))
  const reach = requester ? reachOf(requester, policy, targetOf) : undefined
  const canRead: RepoFilter = reach ? reach.catalog : (other) => policy !== 'off' || sameTeam(other)
  const canReadSnippets: RepoFilter = reach
    ? reach.snippets
    : (other) => policy === 'snippets' || sameTeam(other)
  const teamsOf = (other: RepoRef) => targetOf(other).teams
  const label = options.teamLabel ?? ((team: string) => team)
  const ownerOf = (other: RepoRef) => teamsOf(other).map(label)
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
      ownerOf: (scope) => scopeOwner(scope, teamsOf).map(label),
      teamLabel: label,
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
      teamsOf,
      teamLabel: label,
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
  /** A configured repository by `forge:path`, with its owner teams; `undefined` for anything else. */
  targetOf: (repo: string) => RepoTarget | undefined
  resolve: GuideResolver
  testIds: (repo: RepoTarget) => Promise<TestIdsSnapshot>
  /** Confirmed families; a repository in the task repository's family is related like a teammate. */
  families: () => Promise<readonly Family[]>
}

/**
 * The `rules` access of an internal agent: `repo_rules` of other configured repositories that share
 * an owner team or a family with the task's repository, without team notes (its own Guide is already the task's
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
          !target.teams.some((team) => options.repo.teams.includes(team)) &&
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
