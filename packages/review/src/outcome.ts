import type { DiffFile, Discussion } from '@holtkeeper/forge'
import type { FindingOutcome, ReactionSignal } from '@holtkeeper/store'

import { markerOf } from './dedupe.ts'
import { parseHunks } from './diff.ts'
import type { ReviewData, ReviewFinding } from './schema.ts'

/** A posted finding with the review run that first posted it. */
export interface FindingOrigin {
  finding: ReviewFinding
  /** Head the run reviewed; the finding's lines are numbered as at this commit. */
  head: string
  /** Provider id of the run's main model, when it named one. */
  model?: string
  promptVersion?: string
}

/**
 * The run that first posted each finding of a merge request, by finding id. `runs` must be the
 * merge request's review runs, oldest first. Findings the forge rejected and runs that reviewed
 * nothing (`skipped`, `reply`) contribute nothing.
 */
export function findingOrigins(runs: readonly ReviewData[]): Map<string, FindingOrigin> {
  const origins = new Map<string, FindingOrigin>()
  for (const run of runs) {
    if (run.mode !== 'full' && run.mode !== 'incremental') continue
    for (const finding of run.comments) {
      if (!finding.posted || origins.has(finding.id)) continue
      origins.set(finding.id, {
        finding,
        head: run.head,
        ...(run.usage?.model ? { model: run.usage.model } : {}),
        ...(run.promptVersion ? { promptVersion: run.promptVersion } : {}),
      })
    }
  }
  return origins
}

/**
 * Whether the commits after a review changed the code a finding points at: `changes` is the diff
 * from the reviewed head to a later one. A line the diff removes inside `startLine..line`, or
 * adds right inside or next to that range, counts (a fix often adds a guard instead of editing
 * the line); so does deleting the file. Renamed files are found under their old path. `undefined`
 * when the forge left the file's diff out (`binary`, `collapsed`), so nothing is known.
 */
export function linesTouched(
  changes: readonly DiffFile[],
  finding: Pick<ReviewFinding, 'path' | 'line' | 'startLine'>,
): boolean | undefined {
  const file = changes.find((change) => change.oldPath === finding.path)
  if (!file) return false
  if (file.status === 'deleted') return true
  if (file.binary || file.collapsed) return undefined
  const first = finding.startLine ?? finding.line
  const last = finding.line
  for (const hunk of parseHunks(file.diff)) {
    // The old line an added line follows; an addition touches the range between first - 1 and last.
    let previous = hunk.oldStart - 1
    for (const line of hunk.lines) {
      if (line.kind === 'remove') {
        if ((line.oldLine ?? 0) >= first && (line.oldLine ?? 0) <= last) return true
        previous = line.oldLine ?? previous
      } else if (line.kind === 'context') previous = line.oldLine ?? previous
      else if (previous >= first - 1 && previous <= last) return true
    }
  }
  return false
}

/**
 * What became of a comment: `fixed` when its lines changed after the review, whatever the state
 * of the thread; else `resolved` when the thread is resolved, `ignored` when it is open and the
 * lines are known to be unchanged, `unknown` otherwise (`touched` unknown and the thread open).
 */
export function findingOutcome(input: {
  resolved: boolean
  touched: boolean | undefined
}): FindingOutcome {
  if (input.touched) return 'fixed'
  if (input.resolved) return 'resolved'
  return input.touched === false ? 'ignored' : 'unknown'
}

const isOurs = (note: { author: string; body: string }, botUsername?: string) =>
  markerOf(note.body) !== undefined || (botUsername !== undefined && note.author === botUsername)

/** Notes after the first in `discussion` that people other than Holtkeeper wrote. */
export function humanReplies(discussion: Discussion, botUsername?: string): number {
  return discussion.notes
    .filter((note) => !note.system)
    .slice(1)
    .filter((note) => !isOurs(note, botUsername)).length
}

/** The part of a `ReactionSignal` that says what became of a comment and where it came from. */
export type OutcomeFields = Pick<
  ReactionSignal,
  | 'outcome'
  | 'mergeRequestState'
  | 'severity'
  | 'source'
  | 'model'
  | 'promptVersion'
  | 'humanReplies'
>

/**
 * The outcome fields of one of our inline comments after its merge request ended. `changes` is
 * the diff from the head `origin` reviewed to the merge request's final head; leave it out when
 * the forge cannot compare commits, then only a resolved thread has a known outcome. Without an
 * `origin` (the comment is not in any stored run) only the outcome and reply count are set, and
 * `unknown` stays unless the thread is resolved.
 */
export function outcomeFields(input: {
  state: 'merged' | 'closed'
  discussion: Discussion
  origin?: FindingOrigin
  changes?: readonly DiffFile[]
  botUsername?: string
}): OutcomeFields {
  const { origin, discussion } = input
  const touched = origin && input.changes ? linesTouched(input.changes, origin.finding) : undefined
  return {
    outcome: findingOutcome({ resolved: discussion.resolved, touched }),
    mergeRequestState: input.state,
    humanReplies: humanReplies(discussion, input.botUsername),
    ...(origin
      ? {
          severity: origin.finding.severity,
          source: origin.finding.source,
          ...(origin.model ? { model: origin.model } : {}),
          ...(origin.promptVersion ? { promptVersion: origin.promptVersion } : {}),
        }
      : {}),
  }
}
