import type { DiffFile, Discussion, GitForge, MergeRequestRecord, RepoRef } from '@holtkeeper/forge'
import type { LearningSource } from '@holtkeeper/store'

/** Most characters of all review comments together. */
export const COMMENTS_CHARS = 24_000
/** Most characters of one note and of one rendered comment thread. */
export const NOTE_CHARS = 500
export const COMMENT_CHARS = 1_200
/** Code blocks longer than this are replaced by a marker. */
export const CODE_BLOCK_CHARS = 300
/** Most replies of a thread rendered after its first note. */
export const REPLIES = 3
/** Most commit comparisons one collection makes. */
export const MAX_COMPARES = 60
/** Lines around a commented line whose change still counts as acting on the comment. */
export const TOUCH_SLACK = 2

/**
 * Why a comment counts as one that led to a change: `changed` when a later commit of its merge
 * request touched the commented lines, `acknowledged` when the author replied that it was done,
 * `resolved` when the thread was resolved and its lines are not known to be unchanged.
 */
export type CommentSignal = 'changed' | 'acknowledged' | 'resolved'

/** A merged merge request a comment belongs to. */
export interface MergeRequestRef {
  id: number
  title: string
  webUrl: string
}

/** A reviewer's comment that led to a change, ready for the prompt and as a learning source. */
export interface ReviewComment {
  /** `c1`, `c2`, ... in prompt order; what the model cites. */
  id: string
  mergeRequest: MergeRequestRef
  path?: string
  line?: number
  signal: CommentSignal
  /** The thread, people named by role only (`author`, `reviewer 1`, ...). */
  text: string
  /** The comment's first note, with its real author. */
  source: LearningSource
}

/** What `collectReviewComments` reads. */
export interface ReviewCommentsInput {
  forge: Pick<
    GitForge,
    'listMergeRequests' | 'listDiscussions' | 'compareCommits' | 'getMergeRequest'
  >
  repo: RepoRef
  /** Merge requests merged before this time are left out. */
  since: Date
  /** Most merge requests listed. */
  maxMergeRequests: number
  /** Most merge requests whose discussions are read, newest merged first. */
  discussionMergeRequests: number
  /** Holtkeeper's own account on the forge: its merge requests and notes are left out. */
  botUsername?: string
  log?: (line: string) => void
  signal?: AbortSignal
}

/** Review comments and what the collection covered. */
export interface ReviewComments {
  /** Best first: `changed`, then `acknowledged`, then `resolved`; newest merge request first within each. */
  comments: ReviewComment[]
  /** Merged merge requests kept after bots and dependency updates were dropped. */
  mergeRequests: MergeRequestRef[]
  /** How many merge requests' discussions were read. */
  discussions: number
  /** Reviewer threads seen, before keeping only those that led to a change. */
  threads: number
  /** False when the forge cannot list merge requests or read discussions. */
  listed: boolean
}

const BOT_NAME =
  /\[bot\]$|(^|[-_.])bot($|[-_.\d])|renovate|dependabot|^project_\d+_bot|^group_\d+_bot/i
const DEPENDENCY_TITLE =
  /^((chore|build|fix|deps)(\((deps|deps-dev|dependencies)\))?:\s*(update|bump|upgrade)\b|(chore|build|fix)\((deps|deps-dev|dependencies)\)|update dependency|bump\s|update module\s)/i
const ACKNOWLEDGED =
  /\b(done|fixed|addressed|updated|changed( it)?|good (catch|point)|agreed|will do)\b/i

/** Whether an author is a bot: Holtkeeper's own account or a name that says so. */
export const isBot = (author: string, botUsername?: string): boolean =>
  (botUsername !== undefined && author === botUsername) || BOT_NAME.test(author)

/** Whether a merge request only updates dependencies, by its title. */
export const isDependencyUpdate = (title: string): boolean => DEPENDENCY_TITLE.test(title.trim())

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 4).trimEnd()} ...`

const noteText = (body: string) =>
  clip(
    body
      .replaceAll(/```[\s\S]*?```/g, (block) =>
        block.length > CODE_BLOCK_CHARS ? '```[code cut]```' : block,
      )
      .replaceAll(/\s*\n\s*/g, ' ')
      .trim(),
    NOTE_CHARS,
  )

/** Link to one note of a merge request: GitHub review comment anchors on `/pull/`, GitLab note anchors otherwise. */
export const noteUrl = (mergeRequestUrl: string, noteId: string | number): string =>
  mergeRequestUrl.includes('/pull/')
    ? `${mergeRequestUrl}#discussion_r${noteId}`
    : `${mergeRequestUrl}#note_${noteId}`

/**
 * Whether `changes` (a diff from the commit a comment was made on to a later one) touched the
 * commented line: a removed line within `TOUCH_SLACK` of it, an added line next to that range, or
 * the file deleted. Renamed files are found under their old path. `undefined` when the forge left
 * the file's diff out.
 */
export function linesTouched(
  changes: readonly DiffFile[],
  path: string,
  line: number,
): boolean | undefined {
  const file = changes.find((change) => change.oldPath === path)
  if (!file) return false
  if (file.status === 'deleted') return true
  if (file.binary || file.collapsed) return undefined
  const first = line - TOUCH_SLACK
  const last = line + TOUCH_SLACK
  let old = 0
  for (const row of file.diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(row)
    if (header) {
      old = Number(header[1])
      continue
    }
    if (!old || row.startsWith('\\') || row.startsWith('---') || row.startsWith('+++')) continue
    if (row.startsWith('-')) {
      if (old >= first && old <= last) return true
      old++
    } else if (row.startsWith('+')) {
      if (old >= first && old <= last + 1) return true
    } else old++
  }
  return false
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const signalRank: Record<CommentSignal, number> = { changed: 0, acknowledged: 1, resolved: 2 }

interface Candidate extends Omit<ReviewComment, 'id'> {
  order: number
}

/**
 * Review comments from merged merge requests that led to a change, the input of the rule miner.
 * Merge requests merged since `since` (at most `maxMergeRequests` listed) are kept unless a bot
 * wrote them or they only update dependencies; the discussions of the newest
 * `discussionMergeRequests` are read. A thread counts when its first note is a person's (not the
 * merge request author's, not a bot's, not a system note) and it led to a change
 * (`CommentSignal`): line comments are checked against the diff from the commented commit to the
 * merge request's final head (`linesTouched`, at most `MAX_COMPARES` comparisons), a resolved
 * thread whose lines are known to be unchanged does not count. Comments stay within
 * `COMMENT_CHARS` each and `COMMENTS_CHARS` together, best first. Forge calls run one after
 * another; a failing read is logged and skipped.
 */
export async function collectReviewComments(input: ReviewCommentsInput): Promise<ReviewComments> {
  const { forge, repo, botUsername, log } = input
  const repoKey = `${repo.forge}:${repo.path}`
  const empty = { comments: [], mergeRequests: [], discussions: 0, threads: 0, listed: false }
  if (!forge.listMergeRequests || !forge.listDiscussions) {
    log?.('merge requests: the forge cannot list them or their discussions')
    return empty
  }
  const since = input.since.toISOString()
  const listed = input.maxMergeRequests
    ? await forge.listMergeRequests(repo.path, {
        state: 'merged',
        updatedAfter: since,
        limit: input.maxMergeRequests,
      })
    : []
  const kept = listed
    .filter(
      (mr): mr is MergeRequestRecord & { mergedAt: string } =>
        mr.mergedAt !== undefined &&
        mr.mergedAt >= since &&
        !isBot(mr.author, botUsername) &&
        !isDependencyUpdate(mr.title),
    )
    .toSorted((a, b) => b.mergedAt.localeCompare(a.mergedAt) || b.id - a.id)
  const mergeRequests = kept.map((mr) => ({ id: mr.id, title: mr.title, webUrl: mr.webUrl }))

  let compares = 0
  const compare = async (from: string, to: string): Promise<DiffFile[] | undefined> => {
    if (!forge.compareCommits || compares >= MAX_COMPARES) return undefined
    compares++
    try {
      return await forge.compareCommits(repo.path, from, to)
    } catch (error) {
      log?.(`compare ${from.slice(0, 8)}..${to.slice(0, 8)}: ${message(error)}`)
      return undefined
    }
  }

  const candidates: Candidate[] = []
  let discussions = 0
  let threads = 0
  for (const mr of kept.slice(0, input.discussionMergeRequests)) {
    if (input.signal?.aborted) break
    let found: Discussion[]
    try {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the forge's rate limit
      found = await forge.listDiscussions(repo.path, mr.id)
      discussions++
    } catch (error) {
      log?.(`merge request !${mr.id}: discussions not read (${message(error)})`)
      continue
    }
    const labels = new Map<string, string>([[mr.author, 'author']])
    const label = (author: string) => {
      let known = labels.get(author)
      if (!known) {
        known = `reviewer ${labels.size}`
        labels.set(author, known)
      }
      return known
    }
    let finalHead = mr.headSha
    const diffs = new Map<string, DiffFile[] | undefined>()
    for (const discussion of found) {
      const notes = discussion.notes.filter(
        (note) => !note.system && !isBot(note.author, botUsername) && note.body.trim(),
      )
      const [first, ...replies] = notes
      if (!first || first.author === mr.author) continue
      threads++
      let touched: boolean | undefined
      const position = discussion.position
      if (position && position.side === 'new') {
        if (!finalHead && forge.getMergeRequest) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- once per merge request, only when needed
            finalHead = (await forge.getMergeRequest(repo.path, mr.id)).headSha
          } catch (error) {
            log?.(`merge request !${mr.id}: head not read (${message(error)})`)
          }
        }
        if (finalHead && finalHead !== position.headSha) {
          if (!diffs.has(position.headSha))
            // oxlint-disable-next-line no-await-in-loop -- see above
            diffs.set(position.headSha, await compare(position.headSha, finalHead))
          const changes = diffs.get(position.headSha)
          touched = changes ? linesTouched(changes, position.path, position.line) : undefined
        } else if (finalHead) touched = false
      }
      const acknowledged = replies.some(
        (note) => note.author === mr.author && ACKNOWLEDGED.test(note.body),
      )
      const signal: CommentSignal | undefined = touched
        ? 'changed'
        : touched === false
          ? undefined
          : acknowledged
            ? 'acknowledged'
            : discussion.resolved
              ? 'resolved'
              : undefined
      if (!signal) continue
      const where = position ? `${position.path}:${position.line} ` : ''
      const text = clip(
        [
          `${where}${label(first.author)}: ${noteText(first.body)}`,
          ...replies
            .slice(0, REPLIES)
            .map((note) => `  ${label(note.author)}: ${noteText(note.body)}`),
        ].join('\n'),
        COMMENT_CHARS,
      )
      candidates.push({
        order: candidates.length,
        mergeRequest: { id: mr.id, title: mr.title, webUrl: mr.webUrl },
        ...(position && { path: position.path, line: position.line }),
        signal,
        text,
        source: {
          repo: repoKey,
          mergeRequest: mr.id,
          discussionId: discussion.id,
          noteId: String(first.id),
          author: first.author,
          at: first.createdAt,
          ...(mr.webUrl && { url: noteUrl(mr.webUrl, first.id) }),
        },
      })
    }
  }

  const comments: ReviewComment[] = []
  let total = 0
  for (const candidate of candidates.toSorted(
    (a, b) => signalRank[a.signal] - signalRank[b.signal] || a.order - b.order,
  )) {
    if (total + candidate.text.length > COMMENTS_CHARS) break
    total += candidate.text.length
    const { order: _order, ...comment } = candidate
    comments.push({ id: `c${comments.length + 1}`, ...comment })
  }
  return { comments, mergeRequests, discussions, threads, listed: true }
}
