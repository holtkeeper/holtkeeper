import type { DiffFile } from '@holtkeeper/forge'

import { type ParsedHunk, addedLines, changedLineCount, newSideLines, parseHunks } from './diff.ts'
import type { SkippedFile } from './schema.ts'

/** Lockfiles, generated code, snapshots and build output: reviewed by nobody, skipped by default. */
export const DEFAULT_IGNORE: readonly string[] = [
  '**/*.lock',
  '**/*.lockb',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/npm-shrinkwrap.json',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/__snapshots__/**',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/generated/**',
  '**/*.generated.*',
  '**/*.gen.*',
  '**/*.pb.go',
]

/** One file to review. */
export interface FileScope {
  path: string
  oldPath: string
  status: DiffFile['status']
  hunks: ParsedHunk[]
  /** New-side lines to review: the MR's added lines, narrowed to new commits when incremental. */
  lines: Set<number>
  /** Every new-side line the MR diff shows, with its text; comments may target only these. */
  visible: Map<number, string>
}

export interface ReviewScope {
  files: FileScope[]
  skipped: SkippedFile[]
  /** Added plus removed lines of the files in scope; in-scope added lines when incremental. */
  changedLines: number
}

/** Whether `path` matches one of the globs. Patterns without a slash also match base names. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => {
    const pattern = new Bun.Glob(glob)
    return (
      pattern.match(path) || (!glob.includes('/') && pattern.match(path.split('/').at(-1) ?? ''))
    )
  })
}

export interface ScopeOptions {
  ignore: readonly string[]
  /** Diff since the last reviewed head; when given, only lines it adds stay in scope. */
  since?: readonly DiffFile[]
}

/**
 * Picks what to review from a merge request diff: added lines of reviewable files, minus ignored
 * paths, and for incremental reviews only the lines the newer commits added too. Everything left
 * out is listed in `skipped` with the reason.
 */
export function scopeDiff(files: readonly DiffFile[], options: ScopeOptions): ReviewScope {
  const since = options.since
    ? new Map(options.since.map((file) => [file.newPath, addedLines(parseHunks(file.diff))]))
    : undefined
  const scope: ReviewScope = { files: [], skipped: [], changedLines: 0 }
  for (const file of files) {
    const skip = (reason: SkippedFile['reason']) =>
      scope.skipped.push({ path: file.newPath, reason })
    if (file.status === 'deleted') skip('deleted')
    else if (matchesAny(file.newPath, options.ignore)) skip('ignored')
    else if (file.binary) skip('binary')
    else if (file.collapsed) skip('collapsed')
    else {
      const hunks = parseHunks(file.diff)
      let lines = addedLines(hunks)
      const newer = since?.get(file.newPath)
      if (since) lines = new Set([...lines].filter((line) => newer?.has(line)))
      if (lines.size === 0) skip('unchanged')
      else {
        scope.files.push({
          path: file.newPath,
          oldPath: file.oldPath,
          status: file.status,
          hunks,
          lines,
          visible: newSideLines(hunks),
        })
        scope.changedLines += since ? lines.size : changedLineCount(hunks)
      }
    }
  }
  return scope
}
