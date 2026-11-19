import {
  type Action,
  type Principal,
  type RepoTarget,
  type Scope,
  can,
  scopeCoversRepo,
} from '@holtkeeper/access'
import {
  type RegistryTool,
  type RegistryToolset,
  ToolError,
  mountToolsets,
} from '@holtkeeper/agent-tools'
import type { McpToolsetName } from '@holtkeeper/api'
import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import { latestVersions, libraryApi } from '@holtkeeper/libraries'
import type { RepoRuleFile } from '@holtkeeper/rules'
import {
  REPORT_TOOL,
  type SecretReportsAccess,
  secretReportsToolset,
} from '@holtkeeper/secret-reports'
import type { CrossTeamCatalog } from '@holtkeeper/settings'
import type { Store } from '@holtkeeper/store'

import type { ApiCatalog, RepoFilter } from '../api-surface/catalog.ts'
import type { UsageIndex } from '../api-surface/usages.ts'
import { repoKey } from '../context.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import type { RulesResolver } from '../rules.ts'
import { repoDependencies, stackTeamViews } from '../stack.ts'
import { reachOf } from '../visibility.ts'
import { type AskAccess, askToolset } from './ask.ts'
import { type AssetToolsAccess, assetsToolset } from './assets.ts'
import { knowledgeToolset } from './knowledge.ts'
import { type PackageToolsContext, packagesToolset } from './packages.ts'
import { type QaToolsAccess, qaToolset } from './qa.ts'
import type { SupplyToolsAccess } from './repos.ts'
import { CODE_REVIEW_TOOL, type ReviewToolsAccess, reviewsToolset } from './reviews.ts'
import { type RulesAccess, type TestIdsSnapshot, rulesToolset } from './rules.ts'
import type { StackToolsContext } from './stack.ts'

/** Toolsets the MCP endpoint serves, in the order clients list them. */
const MCP_TOOLSETS = [
  'packages',
  'knowledge',
  'rules',
  'assets',
  'reviews',
  'qa',
  'ask',
  'security',
]

/**
 * The only tools that write which the MCP endpoint offers: learned rules, which wait for the
 * approval delay before agents rely on them, review requests, which queue at most one review per
 * merge request head, and secret reports administrators act on. Every other tool with
 * `readOnly: false` stays off MCP, so a new write tool is never exposed to people's clients by
 * accident.
 */
const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'propose_learning',
  CODE_REVIEW_TOOL,
  REPORT_TOOL,
])

/** Toolsets every internal task mounts. */
const BASE_TOOLSETS = ['code', 'docs', 'knowledge', 'packages']

/**
 * Extra toolsets by task kind; tool schemas cost prompt tokens, so tasks mount only what they use.
 * One-shot kinds mount none, so they stay off the agent tool loop.
 * `rules` serves related repositories' rules and test ids: the task's own rules are already its context.
 * Chat replies run without a checkout, so they mount no `code` or `docs`.
 * `git` (read-only history of the checkout) is for reviews, their thread replies and the
 * verification of their findings (`review-verify`). The verification checks a finding against the
 * checkout, so it skips the cross-repository `stack`. Both leave out `docs`: dependencies are not
 * installed in their checkouts, and `packages` answers for them.
 * `ask` answers one question of an MCP caller without a checkout, read-only.
 */
const TASK_TOOLSETS: Record<string, readonly string[]> = {
  review: ['code', 'knowledge', 'packages', 'git', 'stack', 'assets'],
  'review-verify': ['code', 'knowledge', 'packages', 'git'],
  'review-plan': [],
  chat: ['knowledge', 'packages', 'stack', 'rules', 'assets', 'releases', 'ops'],
  ask: ['knowledge', 'packages', 'stack', 'rules', 'assets'],
  'chat-summary': [],
  learning: [],
  'release-notes': [],
  'qa-notes': [],
  'security-triage': [],
  'library-digest': [],
  'rule-miner': [],
  translate: [],
}

/**
 * Task kinds that work in a merge request checkout without installed dependencies: reviews,
 * their parts and the rechecks of their findings and threads.
 */
const UNINSTALLED_CHECKOUT_KINDS: ReadonlySet<string> = new Set([
  'review',
  'review-verify',
  'review-split',
  'triage',
])

/** Whether tasks of `taskKind` run in a checkout whose dependencies are not installed. */
export const dependenciesMissing = (taskKind: string) => UNINSTALLED_CHECKOUT_KINDS.has(taskKind)

/** Names of the toolsets an internal task of `taskKind` mounts, in mount order. */
export function taskToolsets(taskKind: string): readonly string[] {
  return TASK_TOOLSETS[taskKind] ?? BASE_TOOLSETS
}

/** What the MCP toolsets read for one caller. */
export interface McpToolsetsContext extends Omit<PackageToolsContext, 'supply'>, RulesAccess {
  /**
   * Asset policies and assets records; without it the `assets` toolset and the `assets` topic of
   * `repo_rules` are not offered.
   */
  assets?: AssetToolsAccess
  /** Answers questions with an agent; without it (no provider, `mcp.ask` off) `ask` is not offered. */
  ask?: AskAccess
  /**
   * Turns a `repo` argument as the caller wrote it (a bare path, a git remote URL) into
   * `forge:path`; without it tools take `forge:path` only.
   */
  resolveRepo?: (value: string) => string
  /**
   * The repository a `repo` argument (after `resolveRepo`) names, as Holtkeeper knows it (e.g.
   * with the forge's spelling of the path), or `undefined` when it knows none: such a call is
   * refused before the tool runs. Without it every name is passed on as written.
   */
  repoExists?: (repo: string) => Promise<string | undefined>
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
 * repository: `packages`, `knowledge` (reading one
 * rule in full by `id` with `rules`), `rules` (with any of `rules`, `commits`, `testIds`,
 * `releases`, `assets`; `get_rule` only for a token without `knowledge`), `assets` (with `assets`, `repo_assets` only), `reviews`
 * (with `reviews`), `qa` (with `qa`), `ask` (with `ask`) and `security` (with `secretReports`),
 * every one limited by the caller's grants and, but `security`, to the token's `toolsets`. Stack,
 * fleet, operations and release tools stay with the web panel and chat. Tools that write are left out
 * unless `MCP_WRITE_TOOLS` names them; a toolset left without tools is not offered.
 */
export function mcpToolsets(context: McpToolsetsContext): RegistryToolset[] {
  const { assets, reviews, secretReports, qa, ask, toolsets } = context
  const knowledgeServed = !toolsets || toolsets.includes('knowledge')
  const rules = rulesToolset(context, { reader: !knowledgeServed })
  const mounted = mountToolsets(
    [
      packagesToolset(context),
      knowledgeToolset(context.knowledge, context.rules),
      ...(rules ? [rules] : []),
      ...(assets ? [assetsToolset(assets, { policy: false })] : []),
      ...(reviews ? [reviewsToolset(reviews)] : []),
      ...(qa ? [qaToolset(qa)] : []),
      ...(ask ? [askToolset(ask)] : []),
      ...(secretReports ? [secretReportsToolset(secretReports)] : []),
    ],
    toolsets
      ? MCP_TOOLSETS.filter(
          (name) => name === 'security' || toolsets.some((chosen) => chosen === name),
        )
      : MCP_TOOLSETS,
  )
  const { resolveRepo, repoExists } = context
  return mounted.flatMap((toolset) => {
    const tools = toolset.tools
      .filter((tool) => tool.readOnly !== false || MCP_WRITE_TOOLS.has(tool.name))
      .map((tool) =>
        resolveRepo || repoExists
          ? withRepoResolved(
              tool,
              resolveRepo ?? ((value) => value),
              // A secret report must never be lost to a misspelled repository.
              tool.name === REPORT_TOOL ? undefined : repoExists,
            )
          : tool,
      )
    return tools.length ? [{ ...toolset, tools }] : []
  })
}

const REPO_HINT = 'its path such as acme/app (forge:path and a git remote URL work too)'

/**
 * `tool` taking its `repo` argument in any form `resolve` understands: the argument is resolved
 * before the tool and its usage subject see it, a repository `exists` does not know is refused
 * (one it knows under another spelling is passed on in that spelling),
 * and its description says what may be passed.
 * Tools without a `repo` argument are returned as they are.
 */
function withRepoResolved(
  tool: RegistryTool,
  resolve: (value: string) => string,
  exists?: (repo: string) => Promise<string | undefined>,
): RegistryTool {
  const field = tool.input.shape['repo']
  if (!field) return tool
  const resolved = (input: Record<string, unknown>) =>
    typeof input['repo'] === 'string' ? { ...input, repo: resolve(input['repo']) } : input
  const run: RegistryTool['run'] = async (input, ctx) => {
    const args = resolved(input)
    const repo = args['repo']
    if (typeof repo !== 'string' || !exists) return tool.run(args, ctx)
    const known = await exists(repo)
    if (!known)
      throw new ToolError(
        `Holtkeeper knows no repository ${repo}: check the path (as group/app, a git remote URL or forge:path).`,
      )
    return tool.run({ ...args, repo: known }, ctx)
  }
  return {
    ...tool,
    input: tool.input.extend({
      repo: field.describe(
        (field.description ?? 'The repository').replace('forge:path', REPO_HINT),
      ),
    }),
    run,
    ...(tool.subject && { subject: (input) => tool.subject?.(resolved(input)) }),
  }
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
  store: Pick<Store, 'analyses' | 'rules' | 'learnings' | 'settings' | 'libraries'> &
    Partial<Pick<Store, 'audit' | 'kv'>>
  config: HoltkeeperConfig
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
 * The `packages` context of an internal agent working on `repo`, with the `stack` tools; calls
 * without a `repo` are made for `repo`. Without a
 * `requester`, the agent reads every repository's packages, usages, stack and shared notes while
 * `policy` is not `off` (usage snippets only under `snippets`), and only repositories sharing a
 * an owner team with `repo` when it is `off`. With a `requester` (chat), reach is exactly theirs:
 * `canSeeCatalog` and `canSeeSnippets` under `policy`. Audits and team-scoped knowledge stay
 * limited to `repo` (and the requester's `audits:read` and `knowledge:read`); with `supply`, a
 * requester also gets the fleet's findings and licenses exactly as the HTTP endpoints answer them.
 */
export function agentCatalogContext(options: AgentCatalogOptions): PackageToolsContext {
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
    defaultRepo: key,
    knowledge: {
      store,
      config: options.config,
      canReadScope: (scope) =>
        scopeCoversRepo(scope, repo) &&
        (!requester || can(requester, 'knowledge:read', { kind: 'scope', scope })),
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

/** Inputs of `repoRulesAccess`. */
export interface RepoRulesAccessOptions {
  store: Pick<Store, 'rules' | 'learnings'>
  resolve: RulesResolver
  /** A repository's rules files, read from its default branch (`readForgeRuleFiles`). */
  repoFiles: (repo: RepoTarget) => Promise<RepoRuleFile[]>
  /** A repository by `forge:path` whose rules the caller may read; `undefined` otherwise. */
  readable: (repo: string) => RepoTarget | undefined
  /** Whether the caller may read rules and learnings of `scope`. */
  canReadScope: (scope: Scope) => boolean
}

/**
 * `repo_rules` and `get_rule` over the one resolver, limited to what `options` lets the caller
 * read.
 */
export function repoRulesAccess(
  options: RepoRulesAccessOptions,
): NonNullable<RulesAccess['rules']> {
  return {
    resolve: async (value, request) => {
      const target = options.readable(value)
      return target ? options.resolve({ repo: target, ...request }) : undefined
    },
    rule: async (id) => {
      const rule = await options.store.rules.get(id)
      return rule && options.canReadScope(rule.scope) ? rule : undefined
    },
    learning: async (id) => {
      const learning = await options.store.learnings.get(id)
      return learning && options.canReadScope(learning.scope) ? learning : undefined
    },
    repoFile: async (value, path) => {
      const target = options.readable(value)
      if (!target) return undefined
      return (await options.repoFiles(target)).find((file) => file.path === path)
    },
  }
}

/** Inputs of `agentRulesAccess`. */
export interface AgentRulesOptions {
  store: Pick<Store, 'rules' | 'learnings'>
  /** The repository the task works on. */
  repo: RepoTarget
  /** The person the task answers; rules then also need their `knowledge:read`, test ids their `analyses:read`. */
  requester?: Principal
  /** A configured repository by `forge:path`, with its owner teams; `undefined` for anything else. */
  targetOf: (repo: string) => RepoTarget | undefined
  resolve: RulesResolver
  repoFiles: (repo: RepoTarget) => Promise<RepoRuleFile[]>
  testIds: (repo: RepoTarget) => Promise<TestIdsSnapshot>
}

/**
 * The `rules` access of an internal agent: `repo_rules` of other configured repositories that
 * share an owner team with the task's repository (its own rules are already the task's context,
 * so asking for them is refused), `get_rule` for rules and learnings the requester may read and
 * rules files of the task's repository and its teammates, and test ids of any configured
 * repository. Internal agents propose through the knowledge tools, not here.
 */
export function agentRulesAccess(options: AgentRulesOptions): RulesAccess {
  const own = repoKey(options.repo)
  const { requester } = options
  const allows = (action: Action, target: RepoTarget) =>
    !requester || can(requester, action, { kind: 'repo', repo: target })
  const related = (value: string) => {
    const target = options.targetOf(value)
    if (!target || !allows('knowledge:read', target)) return undefined
    return repoKey(target) === own || target.teams.some((team) => options.repo.teams.includes(team))
      ? target
      : undefined
  }
  const shared = repoRulesAccess({
    store: options.store,
    resolve: options.resolve,
    repoFiles: options.repoFiles,
    readable: related,
    canReadScope: (scope) =>
      !requester || can(requester, 'knowledge:read', { kind: 'scope', scope }),
  })
  return {
    rules: {
      ...shared,
      resolve: async (value, request) => {
        const target = options.targetOf(value)
        if (!target || !allows('knowledge:read', target)) return undefined
        if (repoKey(target) === own)
          throw new ToolError(
            "This repository's rules are already in your context; use repo_rules for other repositories.",
          )
        if (!related(value))
          throw new ToolError(
            'repo_rules only serves repositories that share a team with this repository.',
          )
        return options.resolve({ repo: target, ...request })
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
