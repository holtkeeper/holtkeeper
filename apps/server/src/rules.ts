import type { RepoTarget } from '@holtkeeper/access'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { GitForge } from '@holtkeeper/forge'
import {
  DEFAULT_LEARNING_POLICY,
  type LearningPolicy,
  type RepoRuleFile,
  ROOT_RULE_FILES,
  type ResolvedRules,
  parseRuleFile,
  policiesFor,
  resolveRules,
  ruleFilePaths,
  settleLearning,
} from '@holtkeeper/rules'
import {
  learningsApprovalDelayDays,
  learningsExpiryDays,
  resolveGlobalSetting,
  resolveSetting,
} from '@holtkeeper/settings'
import type { KvStore, Learning, RuleAgent, SettingEntry, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { forgeFor, parseRepo, repoTarget, teamLabeler } from './context.ts'

/** What `readForgeRuleFiles` needs from a forge client. */
export type RuleFilesForge = Pick<GitForge, 'readFile' | 'listFiles' | 'headCommit'>

const cachedFiles = z.array(z.object({ path: z.string(), text: z.string() }))

const RULE_FILES_TTL_SECONDS = 7 * 24 * 3600

/**
 * The rules files of a repository's default branch, parsed (`parseRuleFile`, in `ruleFilePaths`
 * order). Lists the whole tree when the forge can, else reads only the root files. With a head
 * sha and `kv` the texts are kept under that sha for seven days and served from there while the
 * head stays; without a head sha every call reads the forge.
 */
export async function readForgeRuleFiles(input: {
  forge: RuleFilesForge
  forgeId: string
  repo: string
  kv?: Pick<KvStore, 'get' | 'set'>
}): Promise<RepoRuleFile[]> {
  const head = await input.forge.headCommit?.(input.repo)
  const key = head && `rules:repo-files:${input.forgeId}:${input.repo}:${head}`
  let texts: { path: string; text: string }[] | undefined
  if (key && input.kv) {
    const cached = cachedFiles.safeParse(await input.kv.get(key))
    if (cached.success) texts = cached.data
  }
  if (!texts) {
    const listed = input.forge.listFiles
      ? (await input.forge.listFiles(input.repo, { recursive: true, ...(head && { ref: head }) }))
          .filter((entry) => entry.type === 'file')
          .map((entry) => entry.path)
      : [...ROOT_RULE_FILES]
    const paths = ruleFilePaths(listed)
    const read = await Promise.all(
      paths.map((path) => input.forge.readFile(input.repo, path, head)),
    )
    texts = paths.flatMap((path, index) => {
      const text = read[index]
      return text?.trim() ? [{ path, text }] : []
    })
    if (key && input.kv) await input.kv.set(key, texts, RULE_FILES_TTL_SECONDS)
  }
  return texts.flatMap(({ path, text }) => {
    const parsed = parseRuleFile(path, text)
    return parsed ? [parsed] : []
  })
}

const numberSetting = (entry: SettingEntry | undefined, fallback: number) =>
  typeof entry?.value === 'number' && Number.isFinite(entry.value) ? entry.value : fallback

/**
 * The learning policy of `repo` from `learnings.approvalDelayDays` and `learnings.expiryDays`,
 * resolved as every scoped setting is; without a repository, the entries for all repositories.
 * Missing or invalid values fall back to `DEFAULT_LEARNING_POLICY`.
 */
export function learningPolicyFor(
  entries: readonly SettingEntry[],
  repo?: RepoTarget,
): LearningPolicy {
  const entry = (key: string) =>
    repo ? resolveSetting(entries, key, repo) : resolveGlobalSetting(entries, key)
  return {
    approvalDelayDays: numberSetting(
      entry(learningsApprovalDelayDays.key),
      DEFAULT_LEARNING_POLICY.approvalDelayDays,
    ),
    expiryDays: numberSetting(entry(learningsExpiryDays.key), DEFAULT_LEARNING_POLICY.expiryDays),
  }
}

/**
 * The one repository a learning scope names exactly (`{ repos: ['forge:path'] }` without globs),
 * with its owner teams; `undefined` for wider scopes.
 */
function learningRepo(
  config: HoltkeeperConfig,
  learning: Pick<Learning, 'scope'>,
): RepoTarget | undefined {
  const { scope } = learning
  if (scope.all || scope.teams?.length || scope.repos?.length !== 1) return undefined
  const value = scope.repos[0] ?? ''
  if (/[*?[\]{}]/.test(value)) return undefined
  try {
    const ref = parseRepo(value)
    return ref && repoTarget(config, ref)
  } catch {
    return undefined
  }
}

/** The policy a learning lives by: its repository's when it names one, else the global one. */
export const policyOfLearning = (
  config: HoltkeeperConfig,
  entries: readonly SettingEntry[],
  learning: Pick<Learning, 'scope'>,
): LearningPolicy => learningPolicyFor(entries, learningRepo(config, learning))

/**
 * Pending and active learnings brought up to `now` (`settleLearning`) without storing anything,
 * so prompts never wait for the leader tick.
 */
export async function liveLearnings(deps: {
  store: Pick<Store, 'learnings' | 'settings'>
  config: HoltkeeperConfig
  now: () => Date
  entries?: readonly SettingEntry[]
}): Promise<Learning[]> {
  const [learnings, entries] = await Promise.all([
    deps.store.learnings.list({ status: ['pending', 'active'] }),
    deps.entries ?? deps.store.settings.list(),
  ])
  const at = deps.now().toISOString()
  return learnings.map((learning) =>
    settleLearning(learning, at, policyOfLearning(deps.config, entries, learning)),
  )
}

/**
 * Settles every pending and active learning (pending past its approval delay becomes active,
 * active without reinforcement past the expiry becomes expired) and stores the ones that changed.
 * Returns how many changed. Run by the leader.
 */
export async function settleLearnings(deps: {
  store: Pick<Store, 'learnings' | 'settings'>
  config: HoltkeeperConfig
  now: () => Date
}): Promise<number> {
  const [learnings, entries] = await Promise.all([
    deps.store.learnings.list({ status: ['pending', 'active'] }),
    deps.store.settings.list(),
  ])
  const at = deps.now().toISOString()
  let changed = 0
  for (const learning of learnings) {
    const settled = settleLearning(learning, at, policyOfLearning(deps.config, entries, learning))
    if (settled === learning) continue
    // oxlint-disable-next-line no-await-in-loop -- few changes per tick, kept in order
    await deps.store.learnings.put(settled)
    changed++
  }
  return changed
}

/** What one agent run asks the resolver for. */
interface RulesRequest {
  repo: RepoTarget
  agent: RuleAgent
  /** Repository-relative paths the run touches; absent: every file-scoped rule, with its paths. */
  files?: readonly string[]
  /** The repository's rules files when the caller read them (a review checkout); else read from the forge. */
  repoFiles?: readonly RepoRuleFile[]
}

/** Inputs of `createRulesResolver`. */
export interface RulesResolverDeps {
  store: Pick<Store, 'rules' | 'learnings' | 'settings'> & Partial<Pick<Store, 'kv'>>
  config: HoltkeeperConfig
  now: () => Date
  /** The forge client of a forge id. Default: the configured forge (`forgeFor`). */
  forgeOf?: (forgeId: string) => RuleFilesForge
  log?: (line: string) => void
}

/** Resolves the rules of one agent run; see `createRulesResolver`. */
export type RulesResolver = (request: RulesRequest) => Promise<ResolvedRules>

/**
 * The one resolver every agent run on a repository goes through (reviews, thread replies, agent
 * tasks, chat, release notes, QA and the MCP `repo_rules` tool): panel rules, the repository's
 * rules files (given, or read from the forge's default branch and cached by head sha), policies
 * from settings for `agent`, and live learnings, combined by `resolveRules` with team keys named
 * as the config names them. A forge that cannot be read leaves the repository files out (logged).
 */
export function createRulesResolver(deps: RulesResolverDeps): RulesResolver {
  const forgeOf = deps.forgeOf ?? ((forgeId: string) => forgeFor(deps.config, forgeId))
  return async (request) => {
    const repoFiles =
      request.repoFiles ??
      (await Promise.resolve()
        .then(() =>
          readForgeRuleFiles({
            forge: forgeOf(request.repo.forge),
            forgeId: request.repo.forge,
            repo: request.repo.path,
            ...(deps.store.kv && { kv: deps.store.kv }),
          }),
        )
        .catch((error: unknown) => {
          deps.log?.(
            `rules: reading rules files of ${request.repo.forge}:${request.repo.path} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          return []
        }))
    const [rules, entries] = await Promise.all([
      deps.store.rules.list(),
      deps.store.settings.list(),
    ])
    const learnings = await liveLearnings({ ...deps, entries })
    return resolveRules({
      repo: request.repo,
      agent: request.agent,
      ...(request.files && { files: request.files }),
      rules,
      repoFiles,
      learnings,
      policies: policiesFor(entries, request.repo, request.agent),
      teamTitle: teamLabeler(deps.config),
    })
  }
}
