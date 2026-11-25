import { CommandError, type CommandRunner } from '@holtkeeper/exec'
import type { DiffFile } from '@holtkeeper/forge'

import { type ChangedFile, parseChangedFiles, parseUnifiedDiff } from './files.ts'

/** The changed files of a range and a way to read their diffs. */
export interface RangeSource {
  files: ChangedFile[]
  /** Diffs of the given paths (new paths, or old ones of deleted files); unknown paths are left out. */
  diffs(paths: readonly string[]): Promise<DiffFile[]>
}

const GIT = ['git', '--literal-pathspecs', '-c', 'core.quotePath=false']
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--find-renames']
const PATHS_PER_CALL = 200

interface GitContext {
  runner: CommandRunner
  dir: string
  signal?: AbortSignal | undefined
}

async function git(context: GitContext, args: readonly string[]) {
  const command = [...GIT, ...args]
  const result = await context.runner.run(command, {
    cwd: context.dir,
    ...(context.signal && { signal: context.signal }),
  })
  if (result.exitCode !== 0) throw new CommandError(command, result)
  return result.stdout
}

const tryGit = (context: GitContext, args: readonly string[]) =>
  git(context, args).then(
    (stdout) => stdout,
    () => undefined,
  )

/**
 * The commit `ref` (a sha, tag or branch) names in the checkout; `undefined` when the checkout
 * lacks it or `ref` starts with `-`. Never fetches: job checkouts come from a mirror that already
 * has every ref, and callers fall back to the forge.
 */
export async function resolveCommit(context: GitContext, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith('-')) return undefined
  const out = await tryGit(context, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ])
  return out?.trim() || undefined
}

/** The changed files between two commits of the checkout, read with `git diff`. */
export async function gitRangeSource(
  context: GitContext,
  fromSha: string,
  toSha: string,
): Promise<RangeSource> {
  const [nameStatus, numstat] = await Promise.all([
    git(context, ['diff', ...DIFF_FLAGS, '--name-status', '-z', fromSha, toSha]),
    git(context, ['diff', ...DIFF_FLAGS, '--numstat', '-z', fromSha, toSha]),
  ])
  const files = parseChangedFiles(nameStatus, numstat)
  const known = new Map(files.map((file) => [file.path, file]))
  return {
    files,
    async diffs(paths) {
      const wanted = paths.filter((path) => known.has(path))
      const chunks: string[][] = []
      for (let i = 0; i < wanted.length; i += PATHS_PER_CALL)
        chunks.push(wanted.slice(i, i + PATHS_PER_CALL))
      const texts = await Promise.all(
        chunks.map((chunk) => {
          const pathspecs = chunk.flatMap((path) => {
            const file = known.get(path)
            return file && file.oldPath !== file.path ? [path, file.oldPath] : [path]
          })
          return git(context, ['diff', ...DIFF_FLAGS, fromSha, toSha, '--', ...pathspecs])
        }),
      )
      const set = new Set(wanted)
      return texts
        .flatMap(parseUnifiedDiff)
        .filter((file) => set.has(file.status === 'deleted' ? file.oldPath : file.newPath))
    },
  }
}

const countLines = (diff: string) => {
  let added = 0
  let deleted = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++
  }
  return { added, deleted }
}

/** A range source over diff files a forge returned (`compareCommits`). */
export function diffFilesSource(diffFiles: readonly DiffFile[]): RangeSource {
  const byPath = new Map(
    diffFiles.map((file) => [file.status === 'deleted' ? file.oldPath : file.newPath, file]),
  )
  return {
    files: [...byPath].map(([path, file]) => ({
      path,
      oldPath: file.oldPath,
      status: file.status,
      ...countLines(file.diff),
      binary: file.binary === true,
    })),
    diffs: async (paths) => paths.flatMap((path) => byPath.get(path) ?? []),
  }
}

/**
 * Subjects of the commits in `fromSha..toSha` without merges, newest first, at most `limit`
 * (default 300); empty when git cannot list them.
 */
export async function commitSubjects(
  context: GitContext,
  fromSha: string,
  toSha: string,
  limit = 300,
): Promise<string[]> {
  const out = await tryGit(context, [
    'log',
    '--no-merges',
    '--format=%s',
    `--max-count=${limit}`,
    `${fromSha}..${toSha}`,
  ])
  return (out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
