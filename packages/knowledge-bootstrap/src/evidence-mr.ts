import type { Discussion, GitForge, MergeRequestRecord } from '@holtkeeper/forge'

import type { BootstrapEvidence } from './evidence-code.ts'

/** Most characters of all merge request evidence together. */
export const MR_CHARS = 24_000
/** Most characters of the merge request titles item, and most titles in it. */
export const TITLES_CHARS = 5_000
export const TITLES = 80
/** Most characters of a description, of one note and of one merge request item. */
export const DESCRIPTION_CHARS = 600
export const NOTE_CHARS = 500
export const MR_ITEM_CHARS = 2_000
/** Code blocks longer than this are replaced by a marker. */
export const CODE_BLOCK_CHARS = 300

/** A merge request a lesson can cite: `mr:<id>`. */
export interface MergeRequestRef {
  id: number
  title: string
  webUrl: string
}

/** What `collectMergeRequestEvidence` reads. */
export interface MergeRequestEvidenceInput {
  forge: Pick<GitForge, 'listMergeRequests' | 'listDiscussions'>
  /** Repository path on the forge. */
  repo: string
  /** Merge requests merged before this time are left out. */
  since: Date
  /** Most merge requests listed. */
  maxMergeRequests: number
  /** Most merge requests whose discussions are read, newest first. */
  discussionMergeRequests: number
  /** Holtkeeper's own account on the forge: its merge requests and notes are left out. */
  botUsername?: string
  log?: (line: string) => void
  signal?: AbortSignal
}

/** Merge request evidence and what it covers. */
export interface MergeRequestEvidence {
  evidence: BootstrapEvidence[]
  /** Merged merge requests kept after bots and dependency updates were dropped. */
  mergeRequests: MergeRequestRef[]
  /** How many merge requests' discussions were read. */
  discussions: number
  /** False when the forge cannot list merge requests. */
  listed: boolean
}

const BOT_NAME =
  /\[bot\]$|(^|[-_.])bot($|[-_.\d])|renovate|dependabot|^project_\d+_bot|^group_\d+_bot/i
const DEPENDENCY_TITLE =
  /^((chore|build|fix|deps)(\((deps|deps-dev|dependencies)\))?:\s*(update|bump|upgrade)\b|(chore|build|fix)\((deps|deps-dev|dependencies)\)|update dependency|bump\s|update module\s)/i

/** Whether an author is a bot: Holtkeeper's own account or a name that says so. */
export const isBot = (author: string, botUsername?: string): boolean =>
  (botUsername !== undefined && author === botUsername) || BOT_NAME.test(author)

/** Whether a merge request only updates dependencies, by its title. */
export const isDependencyUpdate = (title: string): boolean => DEPENDENCY_TITLE.test(title.trim())

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 4).trimEnd()} ...`

/**
 * A merge request description without the template: HTML comments, checkbox lines and headings
 * left with nothing under them are removed, blank runs collapsed.
 */
export function stripTemplate(description: string): string {
  const lines = description
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^\s*[-*]\s*\[[ xX]?\]/.test(line))
  const kept: string[] = []
  for (const [index, line] of lines.entries()) {
    if (/^\s*#{1,6}\s/.test(line)) {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim())
      if (next === undefined || /^\s*#{1,6}\s/.test(next)) continue
    }
    kept.push(line)
  }
  return kept
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
}

const cutCode = (body: string) =>
  body.replaceAll(/```[\s\S]*?```/g, (block) =>
    block.length > CODE_BLOCK_CHARS ? '```\n[code cut]\n```' : block,
  )

const noteText = (body: string) =>
  clip(
    cutCode(body)
      .replaceAll(/\s*\n\s*/g, ' ')
      .trim(),
    NOTE_CHARS,
  )

/**
 * The review threads of one merge request as text, people named by role only: its author is
 * `author`, everyone else `reviewer 1`, `reviewer 2`, ... in order of their first note. System
 * notes and bot notes are dropped. Threads with replies come first, then comments on a diff line,
 * then general comments.
 */
export function renderDiscussions(
  discussions: readonly Discussion[],
  mrAuthor: string,
  botUsername?: string,
): string[] {
  const labels = new Map<string, string>([[mrAuthor, 'author']])
  const label = (author: string) => {
    let known = labels.get(author)
    if (!known) {
      known = `reviewer ${labels.size}`
      labels.set(author, known)
    }
    return known
  }
  const threads = discussions
    .map((discussion, index) => ({
      discussion,
      index,
      notes: discussion.notes.filter(
        (note) => !note.system && !isBot(note.author, botUsername) && note.body.trim(),
      ),
    }))
    .filter((thread) => thread.notes.length)
  const rank = (thread: (typeof threads)[number]) =>
    thread.notes.length >= 2 ? 0 : thread.discussion.position ? 1 : 2
  const ordered = threads.toSorted((a, b) => rank(a) - rank(b) || a.index - b.index)
  for (const thread of threads) for (const note of thread.notes) label(note.author)
  return ordered.map(({ discussion, notes }) => {
    const where = discussion.position
      ? `${discussion.position.path}:${discussion.position.line} `
      : ''
    const [first, ...replies] = notes
    return [
      `- ${where}${label(first?.author ?? '')}: ${noteText(first?.body ?? '')}`,
      ...replies.map((note) => `  ${label(note.author)}: ${noteText(note.body)}`),
    ].join('\n')
  })
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Merge request evidence for starter knowledge: merged merge requests since `since` (at most
 * `maxMergeRequests` listed), without bot authors and dependency updates, as one titles item
 * (`mr-titles`) and, for the newest `discussionMergeRequests`, one `mr:<id>` item each with the
 * description (template stripped) and the review threads (`renderDiscussions`). A merge request
 * with neither is left out. Items stay within their caps and `MR_CHARS` in total. One list request
 * plus one discussions request per merge request read, one after another; a forge that cannot
 * list merge requests gives nothing (`listed: false`), a failing discussions read is logged and
 * skipped.
 */
export async function collectMergeRequestEvidence(
  input: MergeRequestEvidenceInput,
): Promise<MergeRequestEvidence> {
  const { forge, repo, botUsername, log } = input
  if (!forge.listMergeRequests) {
    log?.('merge requests: the forge cannot list them; code evidence only')
    return { evidence: [], mergeRequests: [], discussions: 0, listed: false }
  }
  const since = input.since.toISOString()
  const listed = input.maxMergeRequests
    ? await forge.listMergeRequests(repo, {
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
  const evidence: BootstrapEvidence[] = []
  let total = 0
  const add = (item: BootstrapEvidence) => {
    if (total + item.text.length > MR_CHARS) return false
    total += item.text.length
    evidence.push(item)
    return true
  }
  if (kept.length) {
    const titles = kept
      .slice(0, TITLES)
      .map((mr) => `!${mr.id} ${mr.title}${mr.labels.length ? ` [${mr.labels.join(', ')}]` : ''}`)
    add({
      id: 'mr-titles',
      label: `Merged merge requests since ${since.slice(0, 10)}`,
      text: clip(titles.join('\n'), TITLES_CHARS),
    })
  }

  let discussions = 0
  for (const mr of kept.slice(0, input.discussionMergeRequests)) {
    if (input.signal?.aborted) break
    const description = clip(stripTemplate(mr.description ?? ''), DESCRIPTION_CHARS)
    let threads: string[] = []
    if (forge.listDiscussions) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the forge's rate limit
        const found = await forge.listDiscussions(repo, mr.id)
        threads = renderDiscussions(found, mr.author, botUsername)
        discussions++
      } catch (error) {
        log?.(`merge request !${mr.id}: discussions not read (${message(error)})`)
      }
    }
    if (!description && !threads.length) continue
    const text = clip(
      [
        description && `Description:\n${description}`,
        threads.length ? `Review threads:\n${threads.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      MR_ITEM_CHARS,
    )
    if (!add({ id: `mr:${mr.id}`, label: `!${mr.id} ${mr.title}`, text })) break
  }
  return { evidence, mergeRequests, discussions, listed: true }
}
