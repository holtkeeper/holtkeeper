import type { Principal, RepoTarget } from '@holtkeeper/access'
import type { LearningSourceKind } from '@holtkeeper/api'
import type { DiffFile, Discussion, GitForge, RepoRef } from '@holtkeeper/forge'
import { reactionCounts } from '@holtkeeper/forge'
import {
  type CaptureOutcome,
  acceptLearning,
  captureLearning,
  defaultLearningScope,
  familyOf,
  looksLikeFeedback,
  parseGuideScope,
  repoKey,
  scopesFor,
} from '@holtkeeper/guide'
import {
  commentFinding,
  findingOrigins,
  markerOf,
  outcomeFields,
  reviewDataSchema,
  reviewRef,
} from '@holtkeeper/review'
import {
  type LearningAutoAcceptSource,
  type LearningsAutoAccept,
  learningsAutoAcceptSchema,
  resolveSetting,
} from '@holtkeeper/settings'
import {
  AUTO_ACCEPT_ACTOR,
  type GuideScopeKey,
  type LearningCandidate,
  type SettingEntry,
} from '@holtkeeper/store'

import { appendAudit } from './audit.ts'
import { type ServerDeps, parseRepo, repoTarget } from './context.ts'
import { editAction, guideScopePermission } from './routes/guides.ts'

const off: LearningsAutoAccept = { sources: [], scope: 'suggested' }

/** `learnings.autoAccept` for a repository and the entry it comes from; off when unset or invalid. */
function learningsAutoAcceptFrom(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
): { policy: LearningsAutoAccept; entry?: SettingEntry } {
  const entry = resolveSetting(entries, 'learnings.autoAccept', repo)
  const parsed = learningsAutoAcceptSchema.safeParse(entry?.value)
  return parsed.success && entry ? { policy: parsed.data, entry } : { policy: off }
}

const triggerOf = (candidate: LearningCandidate, origin: LearningAutoAcceptSource) => {
  if (origin === 'mcp') return candidate.proposal ? { proposedBy: candidate.proposal.by } : {}
  const source = candidate.sources.at(-1)
  return source
    ? {
        author: source.author,
        mergeRequest: source.mergeRequest,
        ...(source.url && { url: source.url }),
      }
    : {}
}

/**
 * Accepts a `proposed` candidate without review when the `learnings.autoAccept` entry of its
 * repository lists `origin`: into its target or suggested scope (`defaultLearningScope`) when that
 * entry's own scope covers it, else into the repository, so an entry never reaches a team,
 * folder or family wider than itself. The acceptance is made by `AUTO_ACCEPT_ACTOR` and audited as
 * `learning.accept` with `details.auto` and what triggered it (`proposedBy`, or the replying
 * `author`, `mergeRequest` and `url`). Callers check who may trigger an origin. Returns the accepted
 * candidate; `undefined` when the policy leaves it proposed or accepting failed (logged, so the
 * proposal itself always stands). People reject it in Knowledge › Learnings like any other.
 */
export async function autoAcceptLearning(
  deps: Pick<ServerDeps, 'store' | 'config' | 'now'>,
  candidate: LearningCandidate,
  origin: LearningAutoAcceptSource,
): Promise<LearningCandidate | undefined> {
  if (candidate.status !== 'proposed') return undefined
  try {
    const repo = parseRepo(candidate.repo)
    if (!repo) return undefined
    const target = repoTarget(deps.config, repo)
    const { policy, entry } = learningsAutoAcceptFrom(
      await deps.store.settings.list('learnings.autoAccept'),
      target,
    )
    if (!entry || !policy.sources.includes(origin)) return undefined
    const family = familyOf(await deps.store.families.list(), candidate.repo)
    const scopes = scopesFor(target, family?.id)
    const suggested =
      policy.scope === 'suggested' ? defaultLearningScope(candidate, scopes) : undefined
    const permitted = guideScopePermission(deps.config)
    const entryScope: Principal = {
      ...AUTO_ACCEPT_ACTOR,
      grants: [{ scope: entry.scope, actions: ['*'] }],
    }
    const covered = (key: GuideScopeKey) => {
      const parsed = parseGuideScope(key)
      return parsed !== undefined && permitted(entryScope, editAction(parsed), parsed, family)
    }
    const scope = suggested && covered(suggested) ? suggested : scopes[0]
    if (!scope) return undefined
    const at = deps.now().toISOString()
    const accepted = await acceptLearning(deps.store, candidate, {
      scope,
      by: AUTO_ACCEPT_ACTOR.id,
      at,
    })
    await appendAudit(deps.store, {
      at,
      actor: AUTO_ACCEPT_ACTOR,
      via: 'system',
      action: 'learning.accept',
      target: { type: 'learning', id: accepted.id, repo: accepted.repo },
      outcome: 'ok',
      details: {
        auto: true,
        origin,
        scope,
        section: accepted.section,
        rule: accepted.rule,
        ...triggerOf(candidate, origin),
      },
    })
    return accepted
  } catch (error) {
    console.error('learnings: auto-accept failed', error)
    return undefined
  }
}

/** What learning capture reads of a reply event. */
export interface ReplyEvent {
  repo: RepoRef
  mergeRequest: number
  author: string
  body: string
}

/** The note of `discussion` the event describes: the newest one by its author with its text. */
const replyNote = (discussion: Discussion, event: ReplyEvent) => {
  const mine = discussion.notes.filter((note) => !note.system && note.author === event.author)
  return mine.findLast((note) => note.body.trim() === event.body.trim()) ?? mine.at(-1)
}

/**
 * Looks at a reply in one of Holtkeeper's review threads for a lasting rule (`captureLearning`),
 * on the automatic agent of `deps.automaticAgentFor`, so the budget reserve is kept. Replies that
 * do not read like feedback, and replies already looked at, make no LLM call. The merge request's
 * URL is read from the forge only for a reply that passes the filter. A new candidate is accepted
 * at once when `learnings.autoAccept` lists `review-reply` (`autoAcceptLearning`).
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
  const agent = await deps.automaticAgentFor?.(event.repo)
  const webUrl = agent
    ? await forge
        ?.getMergeRequest?.(event.repo.path, event.mergeRequest)
        .then((mr) => mr.webUrl)
        .catch(() => undefined)
    : undefined
  const outcome = await captureLearning(
    { store: deps.store, ...(agent && { agent }), now: deps.now },
    {
      source: {
        repo: repoKey(event.repo),
        mergeRequest: event.mergeRequest,
        discussionId: discussion.id,
        noteId: String(note.id),
        author: event.author,
        at: note.createdAt || deps.now().toISOString(),
        ...(webUrl && { url: `${webUrl}#note_${note.id}` }),
      },
      body: note.body,
      comment: comment.body,
      ...(discussion.position && { path: discussion.position.path }),
      names: [...new Set(discussion.notes.map((item) => item.author).filter(Boolean))],
    },
  )
  if (outcome.status !== 'proposed') return outcome
  const accepted = await autoAcceptLearning(deps, outcome.candidate, 'review-reply')
  return accepted ? { ...outcome, candidate: accepted } : outcome
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
 * Reads what became of every inline comment Holtkeeper posted on a merge request that has ended
 * and stores it per comment under its finding category: the 👍/👎 counts, whether the commented
 * lines changed after the review (`compareCommits` from the head the comment was written at to the
 * final head), the thread's state, replies of people, and the severity, model and prompt version
 * of the review run that first posted the finding. Forge reads only, no LLM; reading again
 * replaces the signals. Merge requests without a stored `review` record (Holtkeeper never reviewed
 * them) and forges without `listNoteReactions` are skipped before any forge request. A forge that
 * cannot compare commits, or fails to, leaves the outcome of open threads `unknown`. Returns how
 * many comments were read.
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
    // oxlint-disable-next-line no-await-in-loop
    await deps.store.learnings.putReactions({
      repo: repoKey(repo),
      mergeRequest,
      noteId: String(first.id),
      category: finding.category,
      findingId: finding.findingId,
      ...counts,
      ...outcomeFields({
        state: ended.state,
        discussion,
        ...(origin ? { origin } : {}),
        ...(diff ? { changes: diff } : {}),
        ...(ended.botUsername ? { botUsername: ended.botUsername } : {}),
      }),
      updatedAt: deps.now().toISOString(),
    })
    read++
  }
  return read
}

const distinct = (values: readonly string[]) => new Set(values).size

const discussionsOf = (candidate: LearningCandidate) =>
  distinct(
    candidate.sources.map(
      (source) => `${source.repo}\u0000${source.mergeRequest}\u0000${source.discussionId}`,
    ),
  )

/**
 * How a candidate came about: a direct proposal without replies is `mcp`, several discussions or
 * a proposal with replies are `merged`, anything else is one `review-reply`.
 */
export function learningSourceKind(candidate: LearningCandidate): LearningSourceKind {
  if (candidate.proposal && candidate.sources.length === 0) return 'mcp'
  if (candidate.proposal || discussionsOf(candidate) > 1) return 'merged'
  return 'review-reply'
}

/**
 * 1–5 from the sources alone: 1, plus 1 each for at least 2 distinct discussions, 2 distinct
 * authors, 2 distinct repositories and 3 distinct authors. Authors are the reply authors and the
 * proposer of a direct proposal; repositories include the candidate's own.
 */
export function learningConfidence(candidate: LearningCandidate): number {
  const authors = distinct([
    ...candidate.sources.map((source) => source.author),
    ...(candidate.proposal ? [candidate.proposal.by] : []),
  ])
  const repos = distinct([candidate.repo, ...candidate.sources.map((source) => source.repo)])
  const score =
    1 +
    Number(discussionsOf(candidate) >= 2) +
    Number(authors >= 2) +
    Number(repos >= 2) +
    Number(authors >= 3)
  return Math.min(score, 5)
}

/**
 * `candidate` without its `targetScope` once that is no longer one of `scopes` (its repository's
 * `scopesFor`), so a view names the scope accepting it without a scope actually uses.
 */
export function withLiveTarget(
  candidate: LearningCandidate,
  scopes: readonly GuideScopeKey[],
): LearningCandidate {
  if (!candidate.targetScope || scopes.includes(candidate.targetScope)) return candidate
  const { targetScope: _stale, ...rest } = candidate
  return rest
}
