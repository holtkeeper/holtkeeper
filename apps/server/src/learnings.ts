import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Scope } from '@holtkeeper/access'
import type { Agent } from '@holtkeeper/agent'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { DiffFile, Discussion, GitForge, RepoRef } from '@holtkeeper/forge'
import { reactionCounts } from '@holtkeeper/forge'
import {
  commentFinding,
  citedRules,
  findingOrigins,
  markerOf,
  outcomeFields,
  reviewDataSchema,
  reviewRef,
} from '@holtkeeper/review'
import {
  type LearningDraft,
  type LearningSignal,
  findDuplicateLearning,
  newLearning,
  reinforceLearning,
} from '@holtkeeper/rules'
import type { Learning, LearningSource, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { type ServerDeps, repoKey, repoTarget } from './context.ts'
import { policyOfLearning } from './rules.ts'

/** Most characters of a learned rule. */
export const LEARNING_TEXT_MAX = 200

/** Spend cap of one extraction call in USD. */
const LEARNING_CALL_CAP_USD = 0.02

/** `taskKind` of extraction runs, for budgets and usage reports. */
const LEARNING_TASK_KIND = 'learning'

const MAX_EXCERPT = 1_500
const MAX_KNOWN = 30

/** What `addLearning` did: stored a new learning, or reinforced the one it repeats. */
export type AddLearningOutcome =
  | { status: 'added'; learning: Learning }
  | { status: 'merged'; learning: Learning }

/**
 * Stores `draft` as a new learning (`newLearning`: pending for the approval delay of its
 * repository, or active at once with `approvedBy` or a delay of 0), unless an existing learning
 * states the same rule (`findDuplicateLearning`, rejected ones included): that one is reinforced
 * with the draft's source instead and returned as `merged`, its status kept.
 */
export async function addLearning(
  deps: {
    store: Pick<Store, 'learnings' | 'settings'>
    config: HoltkeeperConfig
    now: () => Date
  },
  draft: LearningDraft,
  options: { approvedBy?: string; newId?: () => string } = {},
): Promise<AddLearningOutcome> {
  const at = deps.now().toISOString()
  const [existing, entries] = await Promise.all([
    deps.store.learnings.list(),
    deps.store.settings.list(),
  ])
  const duplicate = findDuplicateLearning(draft.text, existing)
  if (duplicate) {
    const merged = draft.source
      ? reinforceLearning(duplicate, { source: draft.source }, at)
      : duplicate
    if (merged !== duplicate) await deps.store.learnings.put(merged)
    return { status: 'merged', learning: merged }
  }
  const learning = newLearning(draft, {
    id: options.newId?.() ?? crypto.randomUUID(),
    now: at,
    policy: policyOfLearning(deps.config, entries, draft),
    ...(options.approvedBy !== undefined && { approvedBy: options.approvedBy }),
  })
  await deps.store.learnings.put(learning)
  return { status: 'added', learning }
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

const CODE = /(```[\s\S]*?```|`[^`\n]+`)/

const MENTION = /(^|[\s(])@([\w-]+)(?![\w/(-]|\.[\w-])/g

const cleanProse = (text: string, names: readonly string[]) => {
  let prose = text.replace(MENTION, (_match, before: string) => before)
  for (const name of names)
    prose = prose.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_@./-])${escape(name)}(?![\\p{L}\\p{N}_/-]|\\.\\w)`, 'giu'),
      '',
    )
  return prose.replace(/\s+/g, ' ').replace(/ ([.,;:!?])(?= |$)/g, '$1')
}

/**
 * `text` single-spaced and at most `LEARNING_TEXT_MAX` characters (cut at a word, ending with
 * `…`), with person `@mentions` and every name of `names` removed from its prose; inline and
 * fenced code stay as they are.
 */
export function cleanLearningText(text: string, names: readonly string[] = []): string {
  const people = names.map((name) => name.trim()).filter((name) => name.length >= 2)
  const cleaned = text
    .split(CODE)
    .map((part, index) => (index % 2 ? part : cleanProse(part, people)))
    .join('')
    .trim()
  if (cleaned.length <= LEARNING_TEXT_MAX) return cleaned
  const cut = cleaned.slice(0, LEARNING_TEXT_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${cut.slice(0, space > LEARNING_TEXT_MAX / 2 ? space : cut.length).trimEnd()}…`
}

/** The claim key of one reply note: the same note is never sent to an LLM twice. */
const replyKey = (source: LearningSource) =>
  `learning:${source.repo}!${source.mergeRequest}#${source.noteId}`

const extractionOutput = z.object({
  /** Empty when the reply teaches no lasting rule. */
  text: z.string(),
  scope: z.enum(['repo', 'team']),
  files: z.array(z.string()).optional(),
})

const LEARNING_SYSTEM = [
  'You read a developer reply to an automated code review comment and decide whether it states a lasting rule for future reviews.',
  'Answer with text "" unless the reply states a convention, a deliberate design decision or something reviews should not flag, beyond this one change. Thanks, agreeing to fix, questions and one-off explanations give "".',
  `The rule is one imperative English sentence of at most ${LEARNING_TEXT_MAX} characters about the code. Never name or mention a person, a username or an @handle.`,
  'scope: repo when it is about this repository (most rules); team when it is a practice of the team that owns it across its repositories. Prefer repo when unsure.',
  'files: path globs the rule is about, only when it clearly concerns some files (e.g. "src/legacy/**"); leave it out otherwise.',
  'When the reply only restates one of the known rules, return that rule exactly as written.',
].join('\n')

/** What learning capture reads of a reply event. */
export interface ReplyEvent {
  repo: RepoRef
  mergeRequest: number
  author: string
  body: string
}

/** What looking at one reply did. */
export type CaptureOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'none'; costUsd: number }
  | { status: 'added' | 'merged'; learning: Learning }

/** The note of `discussion` the event describes: the newest one by its author with its text. */
const replyNote = (discussion: Discussion, event: ReplyEvent) => {
  const mine = discussion.notes.filter((note) => !note.system && note.author === event.author)
  return mine.findLast((note) => note.body.trim() === event.body.trim()) ?? mine.at(-1)
}

const excerpt = (text: string) => {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  return clean.length > MAX_EXCERPT ? `${clean.slice(0, MAX_EXCERPT)}\n[...]` : clean
}

async function knownRules(store: Pick<Store, 'learnings'>, repo: string) {
  const known = await store.learnings.list({ status: ['pending', 'active'] })
  const texts = known
    .filter((learning) => learning.scope.repos?.includes(repo))
    .slice(0, MAX_KNOWN)
    .map((learning) => learning.text)
    .toSorted()
  return texts.length
    ? `Known rules of this repository:\n${texts.map((text) => `- ${text}`).join('\n')}`
    : 'This repository has no known rules yet.'
}

/**
 * Looks at a reply in one of Holtkeeper's review threads for a lasting rule, on the automatic
 * agent of `deps.automaticAgentFor`, so the budget reserve is kept. Replies that do not read like
 * feedback (`looksLikeFeedback`) make no LLM call; a reply that passes is claimed by its note, so
 * the same note never makes two calls, and a failed call releases the claim and rethrows. The rule
 * becomes a learning of origin `reply` scoped to the repository (or its owner teams) through
 * `addLearning`, so a rule the fleet already has is reinforced instead.
 */
export async function captureReplyLearning(
  deps: Pick<ServerDeps, 'store' | 'config' | 'now' | 'automaticAgentFor'>,
  forge: GitForge | undefined,
  event: ReplyEvent,
  discussion: Discussion,
): Promise<CaptureOutcome> {
  const note = replyNote(discussion, event)
  const comment = discussion.notes.find((item) => !item.system)
  if (!note || !comment) return { status: 'skipped', reason: 'the reply note was not found' }
  if (!looksLikeFeedback(note.body))
    return { status: 'skipped', reason: 'the reply does not read like feedback' }
  const agent: Agent | undefined = await deps.automaticAgentFor?.(event.repo)
  if (!agent) return { status: 'skipped', reason: 'no agent' }
  const repo = repoKey(event.repo)
  const webUrl = await forge
    ?.getMergeRequest?.(event.repo.path, event.mergeRequest)
    .then((mr) => mr.webUrl)
    .catch(() => undefined)
  const source: LearningSource = {
    repo,
    mergeRequest: event.mergeRequest,
    discussionId: discussion.id,
    noteId: String(note.id),
    author: event.author,
    at: note.createdAt || deps.now().toISOString(),
    ...(webUrl && { url: `${webUrl}#note_${note.id}` }),
  }
  const { store } = deps
  const key = replyKey(source)
  if (!(await store.learnings.claim(key, deps.now().toISOString())))
    return { status: 'skipped', reason: 'the reply was already looked at' }

  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-learning-'))
  let answer: Awaited<ReturnType<Agent['run']>>
  try {
    answer = await agent.run({
      dir: scratch,
      system: LEARNING_SYSTEM,
      context: await knownRules(store, repo),
      prompt: [
        `Review comment${discussion.position ? ` on ${discussion.position.path}` : ''}:\n${excerpt(comment.body)}`,
        `Reply:\n${excerpt(note.body)}`,
      ].join('\n\n'),
      capabilities: [],
      output: extractionOutput,
      maxTurns: 1,
      maxCostUsd: LEARNING_CALL_CAP_USD,
      tier: 'fast',
      taskKind: LEARNING_TASK_KIND,
    })
  } catch (error) {
    await store.learnings.release(key)
    throw error
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const costUsd = answer.costUsd ?? 0
  const output = extractionOutput.safeParse(answer.output)
  const names = [...new Set(discussion.notes.map((item) => item.author).filter(Boolean))]
  const text = output.success ? cleanLearningText(output.data.text, [event.author, ...names]) : ''
  if (!output.success || !text) return { status: 'none', costUsd }
  const teams = repoTarget(deps.config, event.repo).teams
  const scope: Scope = output.data.scope === 'team' && teams.length ? { teams } : { repos: [repo] }
  const files = output.data.files?.map((glob) => glob.trim()).filter(Boolean)
  const outcome = await addLearning(deps, {
    text,
    scope,
    ...(files?.length && { files }),
    origin: 'reply',
    source,
    model: answer.model ?? 'tier:fast',
    costUsd,
  })
  return outcome.status === 'added'
    ? { status: 'added', learning: outcome.learning }
    : { status: 'merged', learning: outcome.learning }
}

/** How a merge request ended, as `harvestReviewSignals` needs it. */
export interface EndedMergeRequest {
  state: 'merged' | 'closed'
  /** Head of the merge request when it ended; read from the forge when the event did not carry it. */
  headSha?: string
  /** The forge account Holtkeeper comments as, to tell its notes from replies of people. */
  botUsername?: string
}

/**
 * Reinforces every learning a review comment cites as `[learn:<id>]` once per comment (claimed by
 * repository, merge request, note and learning): one use, `actedOn` when its finding was fixed,
 * and one vote per 👍 and 👎. Unknown ids are skipped. Returns how many learnings changed.
 */
async function reinforceCitedLearnings(
  deps: Pick<ServerDeps, 'store' | 'now'>,
  comment: {
    repo: string
    mergeRequest: number
    noteId: string
    body: string
    fixed: boolean
    up: number
    down: number
  },
): Promise<number> {
  const ids = citedRules(comment.body)
    .filter((cited) => cited.kind === 'learn')
    .map((cited) => cited.id)
  let changed = 0
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- a comment cites one or two learnings
    const learning = await deps.store.learnings.get(id)
    if (!learning) continue
    const at = deps.now().toISOString()
    // oxlint-disable-next-line no-await-in-loop
    const first = await deps.store.learnings.claim(
      `learning-cite:${comment.repo}!${comment.mergeRequest}#${comment.noteId}:${id}`,
      at,
    )
    if (!first) continue
    const signals: LearningSignal[] = [
      { cited: true, actedOn: comment.fixed },
      ...Array.from({ length: comment.up }, () => ({ vote: 'up' as const })),
      ...Array.from({ length: comment.down }, () => ({ vote: 'down' as const })),
    ]
    const updated = signals.reduce(
      (current, signal) => reinforceLearning(current, signal, at),
      learning,
    )
    if (updated === learning) continue
    // oxlint-disable-next-line no-await-in-loop
    await deps.store.learnings.put(updated)
    changed++
  }
  return changed
}

/**
 * Reads what became of every inline comment Holtkeeper posted on a merge request that has ended
 * and stores it per comment under its finding category: the 👍/👎 counts, whether the commented
 * lines changed after the review (`compareCommits` from the head the comment was written at to the
 * final head), the thread's state, replies of people, and the severity, model and prompt version
 * of the review run that first posted the finding. Learnings a comment cites are reinforced
 * (`reinforceCitedLearnings`). Forge reads only, no LLM; reading again replaces the signals and
 * reinforces nothing twice. Merge requests without a stored `review` record (Holtkeeper never
 * reviewed them) and forges without `listNoteReactions` are skipped before any forge request. A
 * forge that cannot compare commits, or fails to, leaves the outcome of open threads `unknown`.
 * Returns how many comments were read.
 */
export async function harvestReviewSignals(
  deps: Pick<ServerDeps, 'store' | 'now'>,
  forge: GitForge | undefined,
  repo: RepoRef,
  mergeRequest: number,
  ended: EndedMergeRequest,
): Promise<number> {
  if (!forge?.listDiscussions || !forge.listNoteReactions) return 0
  const heads = await deps.store.analyses.heads({ repo, kind: 'review', limit: 500 })
  if (!heads.some((head) => head.ref === reviewRef(mergeRequest))) return 0
  const records = await deps.store.analyses.list({ repo, kind: 'review', limit: 500 })
  const runs = records
    .filter((record) => record.ref === reviewRef(mergeRequest))
    .toReversed()
    .flatMap((record) => {
      const parsed = reviewDataSchema.safeParse(record.data)
      return parsed.success ? [parsed.data] : []
    })
  const origins = findingOrigins(runs)
  const finalHead =
    ended.headSha ??
    (await forge.getMergeRequest?.(repo.path, mergeRequest).then(
      (mr) => mr.headSha,
      () => undefined,
    ))
  const changesSince = new Map<string, Promise<DiffFile[] | undefined>>()
  const changes = (head: string) => {
    if (!finalHead || !forge.compareCommits) return Promise.resolve(undefined)
    const known = changesSince.get(head)
    if (known) return known
    const read =
      head === finalHead
        ? Promise.resolve<DiffFile[]>([])
        : forge.compareCommits(repo.path, head, finalHead).catch(() => undefined)
    changesSince.set(head, read)
    return read
  }
  const discussions = await forge.listDiscussions(repo.path, mergeRequest)
  let read = 0
  for (const discussion of discussions) {
    const first = discussion.notes.find((note) => !note.system)
    if (!first || markerOf(first.body) === undefined) continue
    const finding = commentFinding(first.body)
    if (!finding) continue
    const origin = origins.get(finding.findingId)
    // oxlint-disable-next-line no-await-in-loop -- one request per comment, kept sequential for the forge's rate limit
    const counts = reactionCounts(await forge.listNoteReactions(repo.path, mergeRequest, first.id))
    // oxlint-disable-next-line no-await-in-loop -- compared once per head, then cached
    const diff = origin ? await changes(origin.head) : undefined
    const outcome = outcomeFields({
      state: ended.state,
      discussion,
      ...(origin ? { origin } : {}),
      ...(diff ? { changes: diff } : {}),
      ...(ended.botUsername ? { botUsername: ended.botUsername } : {}),
    })
    // oxlint-disable-next-line no-await-in-loop
    await deps.store.learnings.putReactions({
      repo: repoKey(repo),
      mergeRequest,
      noteId: String(first.id),
      category: finding.category,
      findingId: finding.findingId,
      ...counts,
      ...outcome,
      updatedAt: deps.now().toISOString(),
    })
    // oxlint-disable-next-line no-await-in-loop
    await reinforceCitedLearnings(deps, {
      repo: repoKey(repo),
      mergeRequest,
      noteId: String(first.id),
      body: first.body,
      fixed: ended.state === 'merged' && outcome.outcome === 'fixed',
      up: counts.up,
      down: counts.down,
    })
    read++
  }
  return read
}
