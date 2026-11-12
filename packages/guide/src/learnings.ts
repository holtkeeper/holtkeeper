import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type {
  GuideLearning,
  GuideScopeKey,
  GuideSectionName,
  LearningCandidate,
  LearningScopeKind,
  LearningSource,
  Store,
} from '@holtkeeper/store'
import { z } from 'zod'

import { guideSections } from './model.ts'

/** Most characters of a learned rule. */
export const LEARNING_RULE_MAX = 200

/** Spend cap of one extraction call in USD. */
export const LEARNING_CALL_CAP_USD = 0.02

/** `taskKind` of extraction runs, for budgets and usage reports. */
export const LEARNING_TASK_KIND = 'learning'

const MAX_EXCERPT = 1_500
const MAX_KNOWN = 30

/** Lowercase letters and digits only, single-spaced: near-identical rules share it. */
export function normalizeRule(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const stripMarkup = (text: string) =>
  text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const ACKNOWLEDGEMENT =
  /^(?:thanks?|thank you|thx|ty|ok(?:ay)?|done|fixed|good catch|nice|agreed?|right|sure|lgtm|will do|\+1|👍|спасибо|ок|поправил|исправил|сделал|согласен)[\s.!,)]*$/iu

const FEEDBACK = [
  /\b(?:we|our team|this (?:repo|repository|project|codebase|team))\b.{0,40}\b(?:do(?:n't| not)|never|always|prefer|use|keep|avoid|allow|want|agreed|decided)\b/i,
  /\b(?:here|in this (?:repo|repository|project|codebase))\b.{0,40}\b(?:we|it'?s|is)\b/i,
  /\b(?:intentional(?:ly)?|on purpose|by design|deliberate(?:ly)?|expected behaviou?r|as designed|false positive|not a (?:bug|problem|issue))\b/i,
  /\b(?:convention|our (?:style|rule|standard|guideline)s?|code style|team rule|policy)\b/i,
  /\b(?:do(?:n't| not)|stop|no need to) (?:flag|report|suggest|comment|ask)\b/i,
  /\b(?:is|are) fine (?:here|in this)\b/i,
  /(?:^|\s)(?:у нас|мы (?:не|всегда|никогда)|так задумано|намеренно|специально|это не баг|принято|договорились|соглашени)/iu,
]

/**
 * Whether a reply to a review comment may teach a lasting rule, decided without an LLM: it must
 * have some substance and read like a convention, a deliberate decision or "do not flag this".
 * Thanks, "fixed" and other acknowledgements never pass.
 */
export function looksLikeFeedback(body: string): boolean {
  const text = stripMarkup(body)
  if (text.length < 15 || text.length > 4_000) return false
  if (text.startsWith('/')) return false
  if (ACKNOWLEDGEMENT.test(text)) return false
  return FEEDBACK.some((pattern) => pattern.test(text))
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `rule` single-spaced and at most `LEARNING_RULE_MAX` characters (cut at a word, ending with
 * `…`), with `@handles` and every name of `names` removed.
 */
export function cleanRule(rule: string, names: readonly string[] = []): string {
  let text = rule.replace(/(^|\s)@[\w.-]+/g, '$1')
  for (const name of names.filter((n) => n.trim().length >= 2))
    text = text.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'giu'),
      '',
    )
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
  if (text.length <= LEARNING_RULE_MAX) return text
  const cut = text.slice(0, LEARNING_RULE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > LEARNING_RULE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The claim key of one reply note: the same note is never sent to an LLM twice. */
export const learningSourceKey = (
  source: Pick<LearningSource, 'repo' | 'mergeRequest' | 'noteId'>,
) => `learning:${source.repo}!${source.mergeRequest}#${source.noteId}`

const scopeKinds = ['repo', 'family', 'group'] as const satisfies readonly LearningScopeKind[]

const extractionOutput = z.object({
  /** Empty when the reply teaches no lasting rule. */
  rule: z.string(),
  section: z.enum(guideSections),
  scope: z.enum(scopeKinds),
})

/** System prompt of the extraction call. */
export const LEARNING_SYSTEM = [
  'You read a developer reply to an automated code review comment and decide whether it states a lasting rule for future reviews.',
  'Answer with rule "" unless the reply states a convention, a deliberate design decision or something reviews should not flag, beyond this one change. Thanks, agreeing to fix, questions and one-off explanations give "".',
  `The rule is one imperative English sentence of at most ${LEARNING_RULE_MAX} characters about the code. Never name or mention a person, a username or an @handle.`,
  'section: review for what reviews should or should not flag (most rules); general, testing, testids, assets, commits or releases when the rule is about that.',
  'scope: repo when it is about this repository; family when it fits every similar repository of the same kind; group when it is a practice of the team or subteam that owns the repository. Prefer repo when unsure.',
  'When the reply only restates one of the known rules, return that rule exactly as written.',
].join('\n')

/** One reply to one of Holtkeeper's review comments. */
export interface ReviewReply {
  source: LearningSource
  /** The reply's text. */
  body: string
  /** Holtkeeper's comment the reply answers, markers removed. */
  comment: string
  /** File the comment is on. */
  path?: string
  /** Usernames of the thread; kept out of the rule. */
  names?: readonly string[]
}

/** What looking at one reply did. */
export type CaptureOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'none'; costUsd: number }
  | { status: 'proposed' | 'merged'; candidate: LearningCandidate }

export interface CaptureDeps {
  store: Pick<Store, 'learnings'>
  /** Runs the extraction; without it nothing is extracted and nothing is claimed. */
  agent?: Agent
  now: () => Date
  newId?: () => string
  signal?: AbortSignal
}

const excerpt = (text: string) => {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  return clean.length > MAX_EXCERPT ? `${clean.slice(0, MAX_EXCERPT)}\n[...]` : clean
}

async function knownRules(store: Pick<Store, 'learnings'>, repo: string) {
  const known = await store.learnings.list({ repos: [repo], status: ['accepted', 'proposed'] })
  const rules = known
    .slice(0, MAX_KNOWN)
    .map((candidate) => candidate.rule)
    .toSorted()
  return rules.length
    ? `Known rules of this repository:\n${rules.map((rule) => `- ${rule}`).join('\n')}`
    : 'This repository has no known rules yet.'
}

/**
 * Turns a reply into a learning candidate. Replies `looksLikeFeedback` rejects cost nothing. A
 * reply that passes is claimed by its note (`learningSourceKey`), so the same note never makes two
 * calls, whether a webhook or polling delivered it; a failed call releases the claim and rethrows
 * (a budget denial included). The call is one fast-tier turn with no tools and a spend cap. A rule
 * whose normalized text matches a candidate of the repository adds this reply to that candidate's
 * sources (`merged`) and keeps its status; otherwise a new `proposed` candidate is stored.
 */
export async function captureLearning(
  deps: CaptureDeps,
  reply: ReviewReply,
): Promise<CaptureOutcome> {
  if (!looksLikeFeedback(reply.body))
    return { status: 'skipped', reason: 'the reply does not read like feedback' }
  if (!deps.agent) return { status: 'skipped', reason: 'no agent' }
  const { store } = deps
  const key = learningSourceKey(reply.source)
  if (!(await store.learnings.claim(key, deps.now().toISOString())))
    return { status: 'skipped', reason: 'the reply was already looked at' }

  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-learning-'))
  let answer: Awaited<ReturnType<Agent['run']>>
  try {
    answer = await deps.agent.run({
      dir: scratch,
      system: LEARNING_SYSTEM,
      context: await knownRules(store, reply.source.repo),
      prompt: [
        `Review comment${reply.path ? ` on ${reply.path}` : ''}:\n${excerpt(reply.comment)}`,
        `Reply:\n${excerpt(reply.body)}`,
      ].join('\n\n'),
      capabilities: [],
      output: extractionOutput,
      maxTurns: 1,
      maxCostUsd: LEARNING_CALL_CAP_USD,
      tier: 'fast',
      taskKind: LEARNING_TASK_KIND,
      ...(deps.signal && { signal: deps.signal }),
    })
  } catch (error) {
    await store.learnings.release(key)
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const costUsd = answer.costUsd ?? 0
  const output = extractionOutput.safeParse(answer.output)
  const rule = output.success
    ? cleanRule(output.data.rule, [reply.source.author, ...(reply.names ?? [])])
    : ''
  const ruleKey = normalizeRule(rule)
  if (!output.success || !ruleKey) return { status: 'none', costUsd }

  const at = deps.now().toISOString()
  const existing = await store.learnings.find(reply.source.repo, ruleKey)
  if (existing) {
    if (existing.sources.some((source) => learningSourceKey(source) === key))
      return { status: 'skipped', reason: 'the reply is already a source' }
    const merged: LearningCandidate = {
      ...existing,
      sources: [...existing.sources, reply.source],
      costUsd: existing.costUsd + costUsd,
      updatedAt: at,
    }
    await store.learnings.put(merged)
    return { status: 'merged', candidate: merged }
  }
  const candidate: LearningCandidate = {
    id: deps.newId?.() ?? crypto.randomUUID(),
    repo: reply.source.repo,
    rule,
    key: ruleKey,
    section: output.data.section,
    suggestedScope: output.data.scope,
    status: 'proposed',
    sources: [reply.source],
    model: answer.model ?? 'tier:fast',
    costUsd,
    createdAt: at,
    updatedAt: at,
  }
  await store.learnings.put(candidate)
  return { status: 'proposed', candidate }
}

/** A rule someone proposes directly for people to review. */
export interface RuleProposal {
  /** `forge:path`. */
  repo: string
  rule: string
  section: GuideSectionName
  suggestedScope?: LearningScopeKind
  reason: string
  /** Principal id of the proposer. */
  by: string
  at: string
}

/** What `proposeRule` did. */
export type RuleProposalOutcome =
  | { status: 'proposed'; candidate: LearningCandidate }
  | { status: 'exists'; candidate: LearningCandidate }

/**
 * Stores a directly proposed rule as a `proposed` learning candidate (no LLM, no cost): it reaches
 * prompts only once a person accepts it. A rule whose normalized text matches a candidate of the
 * repository creates nothing and returns that candidate. Throws when the rule is empty.
 */
export async function proposeRule(
  store: Pick<Store, 'learnings'>,
  proposal: RuleProposal,
  newId: () => string = () => crypto.randomUUID(),
): Promise<RuleProposalOutcome> {
  const rule = cleanRule(proposal.rule)
  const key = normalizeRule(rule)
  if (!key) throw new Error('the rule is empty')
  const existing = await store.learnings.find(proposal.repo, key)
  if (existing) return { status: 'exists', candidate: existing }
  const candidate: LearningCandidate = {
    id: newId(),
    repo: proposal.repo,
    rule,
    key,
    section: proposal.section,
    suggestedScope: proposal.suggestedScope ?? 'repo',
    status: 'proposed',
    sources: [],
    proposal: { by: proposal.by, reason: proposal.reason.trim() },
    model: 'none',
    costUsd: 0,
    createdAt: proposal.at,
    updatedAt: proposal.at,
  }
  await store.learnings.put(candidate)
  return { status: 'proposed', candidate }
}

/** Thrown when an edit would give a candidate the rule of another candidate of its repository. */
export class LearningConflictError extends Error {
  readonly other: string

  constructor(other: string) {
    super(`another candidate of the repository already has this rule (${other})`)
    this.name = 'LearningConflictError'
    this.other = other
  }
}

const linkOf = (source: LearningSource) => ({
  label: `${source.repo}!${source.mergeRequest}`,
  url: source.url ?? '',
})

type GuideWriter = Pick<Store, 'guides'>

async function placeLearning(
  store: GuideWriter,
  scope: GuideScopeKey,
  section: GuideSectionName,
  learning: GuideLearning | undefined,
  id: string,
) {
  const previous = await store.guides.get(scope, section)
  if (!previous && !learning) return
  const kept = (previous?.learnings ?? []).filter((item) => item.id !== id)
  const { version: _, ...row } = previous ?? {
    scope,
    section,
    rules: '',
    steering: '',
    version: 0,
    learnings: [],
  }
  await store.guides.put({ ...row, learnings: learning ? [...kept, learning] : kept })
}

const unplace = (store: GuideWriter, candidate: LearningCandidate) =>
  candidate.status === 'accepted' && candidate.acceptedScope
    ? placeLearning(store, candidate.acceptedScope, candidate.section, undefined, candidate.id)
    : Promise.resolve()

/** What a person changes on a candidate; blank fields keep their value. */
export interface LearningEdit {
  rule?: string
  section?: GuideSectionName
  suggestedScope?: LearningScopeKind
}

async function edited(
  store: Pick<Store, 'learnings'>,
  candidate: LearningCandidate,
  edit: LearningEdit,
): Promise<LearningCandidate> {
  const rule = edit.rule === undefined ? candidate.rule : cleanRule(edit.rule)
  const key = normalizeRule(rule)
  if (!key) throw new Error('the rule is empty')
  if (key !== candidate.key) {
    const other = await store.learnings.find(candidate.repo, key)
    if (other && other.id !== candidate.id) throw new LearningConflictError(other.id)
  }
  return {
    ...candidate,
    rule,
    key,
    section: edit.section ?? candidate.section,
    suggestedScope: edit.suggestedScope ?? candidate.suggestedScope,
  }
}

/**
 * Accepts a candidate into the learnings of `scope`'s `section` (the candidate's section unless the
 * edit names another), optionally edited first. Accepting an accepted candidate again moves it.
 * Returns the stored candidate. Throws `LearningConflictError` when the edited rule is another
 * candidate's.
 */
export async function acceptLearning(
  store: Pick<Store, 'learnings' | 'guides'>,
  candidate: LearningCandidate,
  input: LearningEdit & { scope: GuideScopeKey; by: string; at: string },
): Promise<LearningCandidate> {
  const next = await edited(store, candidate, input)
  await unplace(store, candidate)
  await placeLearning(
    store,
    input.scope,
    next.section,
    {
      id: next.id,
      rule: next.rule,
      sources: next.sources.map(linkOf),
      acceptedBy: input.by,
      acceptedAt: input.at,
    },
    next.id,
  )
  const stored: LearningCandidate = {
    ...next,
    status: 'accepted',
    acceptedScope: input.scope,
    decidedBy: input.by,
    decidedAt: input.at,
    updatedAt: input.at,
  }
  await store.learnings.put(stored)
  return stored
}

/** Rejects a candidate; an accepted one leaves the Guide. */
export async function rejectLearning(
  store: Pick<Store, 'learnings' | 'guides'>,
  candidate: LearningCandidate,
  input: { by: string; at: string },
): Promise<LearningCandidate> {
  await unplace(store, candidate)
  const { acceptedScope: _, ...rest } = candidate
  const stored: LearningCandidate = {
    ...rest,
    status: 'rejected',
    decidedBy: input.by,
    decidedAt: input.at,
    updatedAt: input.at,
  }
  await store.learnings.put(stored)
  return stored
}

/**
 * Edits a candidate's rule, section or suggested scope. An accepted candidate's Guide entry follows
 * the edit. Throws `LearningConflictError` when the rule is another candidate's.
 */
export async function editLearning(
  store: Pick<Store, 'learnings' | 'guides'>,
  candidate: LearningCandidate,
  input: LearningEdit & { by: string; at: string },
): Promise<LearningCandidate> {
  const next = await edited(store, candidate, input)
  const stored: LearningCandidate = { ...next, editedBy: input.by, updatedAt: input.at }
  if (candidate.status === 'accepted' && candidate.acceptedScope) {
    const placed = (await store.guides.get(candidate.acceptedScope, candidate.section))?.learnings
    const entry = placed?.find((item) => item.id === candidate.id)
    await unplace(store, candidate)
    await placeLearning(
      store,
      candidate.acceptedScope,
      next.section,
      {
        id: next.id,
        rule: next.rule,
        sources: next.sources.map(linkOf),
        acceptedBy: entry?.acceptedBy ?? candidate.decidedBy ?? input.by,
        acceptedAt: entry?.acceptedAt ?? candidate.decidedAt ?? input.at,
      },
      next.id,
    )
  }
  await store.learnings.put(stored)
  return stored
}
