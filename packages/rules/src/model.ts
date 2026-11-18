import { globMatches, type RepoTarget, scopeCoversRepo } from '@holtkeeper/access'
import type { RuleAgent, RuleContent } from '@holtkeeper/store'

/** Every agent run a rule can target, in display order. */
export const ruleAgents: readonly RuleAgent[] = ['review', 'task', 'chat', 'release']

export const isRuleAgent = (value: unknown): value is RuleAgent =>
  typeof value === 'string' && (ruleAgents as readonly string[]).includes(value)

/** Whether a rule limited to `agents` (absent: every one) is read by `agent`. */
export const forAgent = (agents: readonly RuleAgent[] | undefined, agent: RuleAgent): boolean =>
  !agents?.length || agents.includes(agent)

/** Whether any of `files` matches any of `globs`. */
export const filesMatch = (globs: readonly string[], files: readonly string[]): boolean =>
  globs.some((glob) => files.some((file) => globMatches(glob, file)))

/**
 * How a rule reaches a prompt: `files` when it names path globs, `requested` when it only has a
 * description (agents ask for it), `always` otherwise.
 */
export type RuleActivation = 'always' | 'files' | 'requested'

export function ruleActivation(
  rule: Pick<RuleContent, 'files' | 'description' | 'alwaysApply'>,
): RuleActivation {
  if (rule.files?.length) return 'files'
  if (rule.description?.trim() && !rule.alwaysApply) return 'requested'
  return 'always'
}

/** Whether a rule's scope covers `repo` and `agent` reads it. */
export const ruleApplies = (
  rule: Pick<RuleContent, 'scope' | 'agents'>,
  repo: RepoTarget,
  agent: RuleAgent,
): boolean => scopeCoversRepo(rule.scope, repo) && forAgent(rule.agents, agent)
