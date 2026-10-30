import type { CodeChange } from '@holtkeeper/changes'
import type { CommandRunner } from '@holtkeeper/exec'
import {
  type QualityCheck,
  type QualityData,
  type QualityIssue,
  analyzeQuality,
  stableId,
} from '@holtkeeper/quality'

import type { ReviewCategory, ReviewSeverity } from './schema.ts'
import type { FileScope } from './scope.ts'
import type { Candidate } from './validate.ts'

/** Quality checks a review may run, restricted to changed lines. */
export const reviewCheckNames = ['lint', 'secrets', 'conventions'] as const
export type ReviewCheckName = (typeof reviewCheckNames)[number]

/** Last line a range touches; an exclusive end at column 1 does not touch its line. */
const lastLine = (range: { start: { line: number }; end: { line: number; column: number } }) =>
  range.end.column === 1 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line

const severityOf = (issue: QualityIssue): ReviewSeverity =>
  issue.category === 'security'
    ? 'critical'
    : issue.severity === 'error'
      ? 'major'
      : issue.severity === 'warning'
        ? 'minor'
        : 'info'

const categoryOf = (issue: QualityIssue): ReviewCategory =>
  issue.category === 'security'
    ? 'security'
    : issue.category === 'tests'
      ? 'tests'
      : issue.category === 'convention' || issue.category === 'style'
        ? 'style'
        : 'maintainability'

/**
 * The replacement for whole lines a change edits, when it is one file's `replace` edits that lie
 * entirely on changed lines and whose `oldText` matches; `undefined` otherwise.
 */
export function suggestionFromChange(
  change: CodeChange,
  file: Pick<FileScope, 'path' | 'lines' | 'visible'>,
): { startLine: number; line: number; replacement: string; original: string } | undefined {
  const edits = change.edits
  if (edits.length === 0) return undefined
  const replaces = edits.flatMap((edit) =>
    edit.kind === 'replace' && edit.file === file.path ? [edit] : [],
  )
  if (replaces.length !== edits.length) return undefined
  const start = Math.min(...replaces.map((edit) => edit.range.start.line))
  const end = Math.max(...replaces.map((edit) => lastLine(edit.range)))
  const texts: string[] = []
  for (let line = start; line <= end; line++) {
    const text = file.visible.get(line)
    if (text === undefined || !file.lines.has(line)) return undefined
    texts.push(text)
  }
  const original = texts.join('\n')
  const offset = (line: number, column: number) =>
    texts.slice(0, line - start).reduce((sum, text) => sum + text.length + 1, 0) + column - 1

  let block = original
  const ordered = replaces.toSorted(
    (a, b) =>
      b.range.start.line - a.range.start.line || b.range.start.column - a.range.start.column,
  )
  for (const edit of ordered) {
    const from = offset(edit.range.start.line, edit.range.start.column)
    const to = offset(edit.range.end.line, edit.range.end.column)
    if (block.slice(from, to) !== edit.oldText) return undefined
    block = block.slice(0, from) + edit.newText + block.slice(to)
  }
  const replacement = block.endsWith('\n') ? block.slice(0, -1) : block
  return replacement === original
    ? undefined
    : { startLine: start, line: end, replacement, original }
}

/**
 * Quality issues that touch lines in scope, as review findings. A fix whose edits fit inside the
 * changed lines becomes the finding's suggestion.
 */
export function findingsFromQuality(
  data: Pick<QualityData, 'issues' | 'changes'>,
  files: ReadonlyMap<string, FileScope>,
): Candidate[] {
  const changes = new Map(data.changes.map((change) => [change.id, change]))
  return data.issues.flatMap((issue): Candidate[] => {
    const file = issue.file ? files.get(issue.file.replace(/^\.?\//, '')) : undefined
    if (!file || !issue.range) return []
    const touched: number[] = []
    for (let line = issue.range.start.line; line <= lastLine(issue.range); line++)
      if (file.lines.has(line)) touched.push(line)
    const line = touched[0]
    if (line === undefined) return []

    const change = issue.changeId ? changes.get(issue.changeId) : undefined
    const suggestion = change ? suggestionFromChange(change, file) : undefined
    const body = [
      issue.message,
      issue.help,
      issue.url ? `[${issue.rule}](${issue.url})` : undefined,
    ].filter(Boolean)
    return [
      {
        path: file.path,
        line: suggestion?.line ?? line,
        ...(suggestion && suggestion.startLine !== suggestion.line
          ? { startLine: suggestion.startLine }
          : {}),
        severity: severityOf(issue),
        category: categoryOf(issue),
        title: `${issue.tool}: ${issue.rule}`,
        body: body.join('\n\n'),
        source: issue.tool,
        ...(suggestion
          ? { suggestion: { replacement: suggestion.replacement, original: suggestion.original } }
          : {}),
      },
    ]
  })
}

export interface DeterministicOptions {
  dir: string
  checks: readonly QualityCheck[]
  runner: CommandRunner
  files: ReadonlyMap<string, FileScope>
  signal?: AbortSignal
}

/** Runs the checks on the checkout and keeps what they report on lines in scope. */
export async function deterministicFindings(options: DeterministicOptions) {
  if (options.checks.length === 0) return { candidates: [], tools: [] }
  const data = await analyzeQuality({
    dir: options.dir,
    checks: options.checks,
    runner: options.runner,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return {
    candidates: findingsFromQuality(data, options.files),
    tools: data.tools.map((tool) => ({
      name: tool.name,
      ok: tool.ok,
      ...(tool.error ? { error: tool.error } : {}),
    })),
  }
}

/** Stable id of a finding: same file, category and title mean the same problem. */
export const findingId = (candidate: Pick<Candidate, 'path' | 'category' | 'title' | 'source'>) =>
  stableId(
    candidate.source,
    candidate.path,
    candidate.category,
    candidate.title.trim().toLowerCase(),
  )
