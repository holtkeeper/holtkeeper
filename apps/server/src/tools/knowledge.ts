import { type RepoTarget, type Scope, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import {
  type KnowledgeAccess,
  type KnowledgeHit,
  PROPOSE_LEARNING_TOOL,
  type RegistryToolset,
  SEARCH_KNOWLEDGE_TOOL,
  ToolError,
  defineTool,
} from '@holtkeeper/agent-tools'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import { forAgent, scopeSource, settleLearning } from '@holtkeeper/rules'
import type { AuditActor, AuditVia, Learning, Rule, RuleAgent, Store } from '@holtkeeper/store'
import { webPaths } from '@holtkeeper/web-paths'
import { z } from 'zod'

import { ForbiddenToolError, repoKey } from '../context.ts'
import { LEARNING_TEXT_MAX, addLearning } from '../learnings.ts'
import { policyOfLearning } from '../rules.ts'

/** Rules and learnings as the knowledge tools read and propose to them, for one caller. */
export interface KnowledgeToolsContext {
  store: Pick<Store, 'rules' | 'learnings' | 'settings'> & Partial<Pick<Store, 'audit'>>
  config: HoltkeeperConfig
  /** Whether the caller may read rules and learnings of `scope` (`knowledge:read`). */
  canReadScope: (scope: Scope) => boolean
  /** `forge:path` with its owner teams when the caller may read that repository's rules. */
  repoOf: (repo: string) => RepoTarget | undefined
  /** How a team key is named in tool output; default the key itself. */
  teamLabel?: (key: string) => string
  /** Principal id or agent actor proposals are attributed to. */
  actor: string
  /** Who proposals are audited as; without it they are not audited. */
  audit?: { actor: AuditActor; via: AuditVia }
  now: () => Date
}

/** A rule or active learning `searchKnowledge` found. */
type KnowledgeMatch =
  | { kind: 'rule'; rule: Rule; score: number }
  | { kind: 'learn'; learning: Learning; score: number }

/** Candidates ranked before the scope filters, so filtering does not starve `limit`. */
const POOL = 200

const PREVIEW = 600

const preview = (text: string) => {
  const trimmed = text.trim()
  return trimmed.length > PREVIEW ? `${trimmed.slice(0, PREVIEW)}…` : trimmed
}

const scopeOf = (match: KnowledgeMatch) =>
  match.kind === 'rule' ? match.rule.scope : match.learning.scope

/** The citation form of a match: `rule:<id>` or `learn:<id>`. */
const citationOf = (match: KnowledgeMatch) =>
  match.kind === 'rule' ? `rule:${match.rule.id}` : `learn:${match.learning.id}`

/**
 * Rules and active learnings matching `query` (full text over `RuleStore.search` and
 * `LearningStore.search`), best first: only those the caller may read, and with `repo` only those
 * whose scope covers it, with `agent` only those it reads. Learnings are settled to now first, so
 * one past its approval delay counts as active before the leader stores it.
 */
async function knowledgeMatches(
  context: KnowledgeToolsContext,
  input: { query: string; repo?: RepoTarget; agent?: RuleAgent; limit?: number },
): Promise<KnowledgeMatch[]> {
  const query = input.query.trim()
  if (!query) return []
  const [rules, learnings, entries] = await Promise.all([
    context.store.rules.search(query, POOL),
    context.store.learnings.search(query, { status: ['pending', 'active'] }, POOL),
    context.store.settings.list(),
  ])
  const at = context.now().toISOString()
  const matches: KnowledgeMatch[] = [
    ...rules.map((hit) => ({ kind: 'rule' as const, rule: hit.rule, score: hit.score })),
    ...learnings.flatMap((hit) => {
      const learning = settleLearning(
        hit.learning,
        at,
        policyOfLearning(context.config, entries, hit.learning),
      )
      return learning.status === 'active'
        ? [{ kind: 'learn' as const, learning, score: hit.score }]
        : []
    }),
  ]
  return matches
    .filter((match) => context.canReadScope(scopeOf(match)))
    .filter((match) => !input.repo || scopeCoversRepo(scopeOf(match), input.repo))
    .filter(
      (match) =>
        !input.agent ||
        forAgent(match.kind === 'rule' ? match.rule.agents : match.learning.agents, input.agent),
    )
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        Number(a.kind === 'learn') - Number(b.kind === 'learn') ||
        scopeSpecificity(scopeOf(b)) - scopeSpecificity(scopeOf(a)),
    )
    .slice(0, input.limit ?? 10)
}

const readableRepo = (context: KnowledgeToolsContext, repo: string) => {
  const target = context.repoOf(repo)
  if (!target)
    throw new ForbiddenToolError(
      `You may not read the rules of ${repo}, or it is not a forge:path.`,
      'knowledge:read',
      repo,
    )
  return target
}

const renderMatch = (match: KnowledgeMatch, label: (key: string) => string) =>
  match.kind === 'rule'
    ? [
        `### [rule:${match.rule.id}] ${match.rule.title}`,
        `_${scopeSource(match.rule.scope, label)}${match.rule.files?.length ? `, files ${match.rule.files.map((glob) => `\`${glob}\``).join(', ')}` : ''}_`,
        preview(match.rule.body),
      ].join('\n')
    : [
        `### [learn:${match.learning.id}] Learned rule`,
        `_${scopeSource(match.learning.scope, label)}${match.learning.files?.length ? `, files ${match.learning.files.map((glob) => `\`${glob}\``).join(', ')}` : ''}; used ${match.learning.uses}×, fixed ${match.learning.actedOn}×_`,
        match.learning.text,
      ].join('\n')

/** Search results as `search_knowledge` prints them. */
export async function searchKnowledge(
  context: KnowledgeToolsContext,
  input: { query: string; repo?: string | undefined; limit?: number | undefined },
): Promise<string> {
  const target = input.repo ? readableRepo(context, input.repo) : undefined
  const matches = await knowledgeMatches(context, {
    query: input.query,
    ...(target && { repo: target }),
    ...(input.limit !== undefined && { limit: input.limit }),
  })
  if (!matches.length)
    return `No rule or learned rule matches "${input.query.trim()}"${input.repo ? ` for \`${input.repo}\`` : ''}.`
  const label = context.teamLabel ?? ((key: string) => key)
  return [
    `${matches.length} match${matches.length === 1 ? '' : 'es'}${target ? ` applying to \`${input.repo}\`` : ''}; cite rules as [rule:<id>] and learned rules as [learn:<id>]. Rules people wrote win over learned rules.`,
    ...matches.map((match) => renderMatch(match, label)),
  ].join('\n\n')
}

/**
 * Proposes a learning of origin `agent` for one repository the caller may read (`addLearning`):
 * pending for the repository's approval delay, or merged into the learning that already states
 * it. Audited as `learning.create` or `learning.reinforce` when `context.audit` is set.
 */
async function proposeLearning(
  context: KnowledgeToolsContext,
  input: { repo: RepoTarget; text: string; reason?: string; files?: string[] },
) {
  const repo = repoKey(input.repo)
  const at = context.now().toISOString()
  const outcome = await addLearning(
    { store: context.store, config: context.config, now: context.now },
    {
      text: input.text,
      ...(input.reason && { reason: input.reason }),
      scope: { repos: [repo] },
      ...(input.files?.length && { files: input.files }),
      origin: 'agent',
      source: { repo, author: context.actor, at },
    },
  )
  if (context.audit && context.store.audit)
    await context.store.audit.append({
      at,
      actor: context.audit.actor,
      via: context.audit.via,
      action: outcome.status === 'added' ? 'learning.create' : 'learning.reinforce',
      target: { type: 'learning', id: outcome.learning.id, repo },
      outcome: 'ok',
      details: { text: outcome.learning.text, origin: 'agent' },
    })
  return outcome
}

const proposalText = (outcome: Awaited<ReturnType<typeof proposeLearning>>, repo: string) => {
  const { learning } = outcome
  const link = webPaths.knowledge('learnings', { learning: learning.id })
  if (outcome.status === 'merged')
    return `Not added: [learn:${learning.id}] (${learning.status}) already says this: "${learning.text}". Your proposal counts as another source for it.`
  return learning.status === 'active'
    ? `Added [learn:${learning.id}] for \`${repo}\`; agents use it from now on (${link}).`
    : `Proposed [learn:${learning.id}] for \`${repo}\`. Agents use it from ${learning.activeAt.slice(0, 10)} unless people reject it earlier in Knowledge › Learnings (${link}).`
}

/**
 * The `knowledge` toolset of the MCP endpoint: `search_knowledge` and `propose_learning`, limited
 * to what `context` lets the caller read.
 */
export function knowledgeToolset(context: KnowledgeToolsContext): RegistryToolset {
  return {
    name: 'knowledge',
    instructions: [
      'Team rules people wrote and rules Holtkeeper learned from reviews:',
      'search_knowledge before solving a problem the team may have solved, cite rules as [rule:<id>] and learned rules as [learn:<id>],',
      'and propose_learning for a lasting convention you learned (it waits for an approval delay before agents rely on it).',
    ].join(' '),
    tools: [
      defineTool({
        name: SEARCH_KNOWLEDGE_TOOL,
        description:
          'Searches the rules people wrote in the panel and the active rules Holtkeeper learned, best match first, bodies trimmed. With `repo`, only those that apply to that repository. Repository rules files (AGENTS.md, ...) are not searched: repo_rules returns them.',
        input: z.object({
          query: z.string().min(1).describe('Words to match, e.g. an API name or error message'),
          repo: z.string().optional().describe('The repository you work in, as forge:path'),
          limit: z.number().int().min(1).max(30).optional().describe('Default 10'),
        }),
        defaultLimit: 10,
        run: (input) => searchKnowledge(context, input),
        subject: (input) => input.repo ?? input.query,
      }),
      defineTool({
        name: PROPOSE_LEARNING_TOOL,
        description:
          'Proposes a learned rule for one repository: one short imperative sentence other people and agents should follow (a convention, a pitfall), not a one-off fact. It is attributed to you and waits for the approval delay before agents use it; a rule that is already known is not added again. Search first.',
        input: z.object({
          repo: z.string().min(1).describe('The repository it applies to, as forge:path'),
          text: z
            .string()
            .min(1)
            .max(LEARNING_TEXT_MAX)
            .describe('One imperative sentence, e.g. "Keep widget sizes in WidgetSize."'),
          reason: z.string().max(1000).optional().describe('Why it holds, with the evidence'),
          files: z
            .array(z.string().min(1))
            .max(10)
            .optional()
            .describe('Path globs it is about, e.g. src/widgets/**'),
        }),
        readOnly: false,
        run: async ({ repo, text, reason, files }) => {
          const target = readableRepo(context, repo)
          if (!text.trim()) throw new ToolError('Not proposed: the rule is empty.')
          const outcome = await proposeLearning(context, {
            repo: target,
            text,
            ...(reason && { reason }),
            ...(files && { files }),
          })
          return proposalText(outcome, repo)
        },
        subject: ({ repo }) => repo,
      }),
    ],
  }
}

/**
 * `KnowledgeAccess` of internal agents over the same search and proposals: hits in citation form
 * for the task's repository, proposals of origin `agent` for it.
 */
export function knowledgeAccessOf(context: KnowledgeToolsContext): KnowledgeAccess {
  return {
    async search(query, ctx) {
      const repo = context.repoOf(`${ctx.repo.forge}:${ctx.repo.path}`)
      if (!repo) return []
      const matches = await knowledgeMatches(context, {
        query,
        repo,
        ...(ctx.limit !== undefined && { limit: ctx.limit }),
      })
      return matches.map((match): KnowledgeHit => ({
        id: citationOf(match),
        title: match.kind === 'rule' ? match.rule.title : 'Learned rule',
        body: match.kind === 'rule' ? match.rule.body : match.learning.text,
        score: match.score,
      }))
    },
    async propose(input, ctx) {
      const repo = context.repoOf(`${ctx.repo.forge}:${ctx.repo.path}`)
      if (!repo) throw new ToolError('This repository does not take learned rules.')
      const outcome = await proposeLearning(
        { ...context, actor: ctx.actor },
        {
          repo,
          text: input.text,
          ...(input.reason && { reason: input.reason }),
          ...(input.files && { files: input.files }),
        },
      )
      return {
        id: outcome.learning.id,
        status: outcome.learning.status,
        ...(outcome.status === 'merged' && { duplicateOf: outcome.learning.id }),
      }
    },
  }
}
