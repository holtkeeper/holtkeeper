// oxlint-disable no-await-in-loop -- every step works on the same checkout
import { dirname, posix } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'

import { type Git, gitIn, resetCheckout, trackedFiles, withTempFile } from './git.ts'
import { formatPatch, patchable, remapFiles } from './patch.ts'
import type { PathMapping, SourceFile } from './types.ts'

const commonSuffix = (a: string, b: string) => {
  const left = a.split('/').toReversed()
  const right = b.split('/').toReversed()
  let count = 0
  while (count < left.length && left[count] === right[count]) count++
  return count
}

/**
 * Path rewrites that make `files` fit the target layout: a missing path maps to the tracked
 * file with the same name and the longest common path suffix (no mapping on ties). New files
 * follow the directory moves those mappings imply.
 */
export function remapPaths(files: SourceFile[], tracked: string[]): PathMapping[] {
  const present = new Set(tracked)
  const byName = new Map<string, string[]>()
  for (const path of tracked) {
    const name = posix.basename(path)
    byName.set(name, [...(byName.get(name) ?? []), path])
  }
  const mappings = new Map<string, string>()
  const directories = new Map<string, string>()
  for (const file of files) {
    if (file.status === 'added' || present.has(file.oldPath) || mappings.has(file.oldPath)) continue
    const candidates = (byName.get(posix.basename(file.oldPath)) ?? []).map((path) => ({
      path,
      score: commonSuffix(path, file.oldPath),
    }))
    const best = Math.max(0, ...candidates.map((candidate) => candidate.score))
    const top = candidates.filter((candidate) => candidate.score === best)
    if (top.length !== 1) continue
    const target = top[0]!.path
    mappings.set(file.oldPath, target)
    directories.set(dirname(file.oldPath), dirname(target))
    if (file.status === 'renamed' && dirname(file.newPath) === dirname(file.oldPath))
      mappings.set(file.newPath, posix.join(dirname(target), posix.basename(file.newPath)))
  }
  for (const file of files) {
    const path = file.status === 'added' || file.status === 'renamed' ? file.newPath : undefined
    if (!path || mappings.has(path) || present.has(path)) continue
    const directory = [...directories.keys()]
      .filter((from) => path === from || path.startsWith(`${from}/`))
      .toSorted((a, b) => b.length - a.length)[0]
    if (directory === undefined) continue
    const to = directories.get(directory)!
    const rest = path.slice(directory.length + 1)
    mappings.set(path, to === '.' ? rest : `${to}/${rest}`)
  }
  return [...mappings]
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => ({ from, to }))
    .toSorted((a, b) => a.from.localeCompare(b.from))
}

/** Writes each known pre-image into the checkout's object store; returns blob ids by file index. */
export async function writePreimages(git: Git, files: SourceFile[]): Promise<Map<number, string>> {
  const blobs = new Map<number, string>()
  for (const [index, file] of files.entries()) {
    if (file.preimage === undefined || file.status === 'added') continue
    const result = await withTempFile(file.preimage, (path) => git.run('hash-object', '-w', path))
    if (result.exitCode === 0 && result.stdout.trim()) blobs.set(index, result.stdout.trim())
  }
  return blobs
}

/** Paths with unresolved conflicts. */
async function unmerged(git: Git): Promise<string[]> {
  const result = await git.run('diff', '--name-only', '--diff-filter=U')
  return result.stdout.split('\n').filter(Boolean)
}

/** Result of one `git apply --3way`. */
export interface ApplyAttempt {
  ok: boolean
  /** Files left with conflict markers; empty when the patch did not apply at all. */
  conflicts: string[]
  output: string
}

/** `git apply --3way` of `files` in the checkout; on failure the checkout is reset. */
export async function applyFiles(git: Git, files: SourceFile[]): Promise<ApplyAttempt> {
  const blobs = await writePreimages(git, files)
  const patch = formatPatch(files, blobs)
  if (!patch.trim())
    return { ok: false, conflicts: [], output: 'nothing in the patch can be applied as text' }
  const result = await withTempFile(patch, (path) =>
    git.run('apply', '--3way', '--whitespace=nowarn', path),
  )
  const output = [result.stdout, result.stderr]
    .filter((part) => part.trim())
    .join('\n')
    .trim()
  const conflicts = await unmerged(git)
  if (result.exitCode === 0 && conflicts.length === 0) {
    await git.run('reset', '-q')
    return { ok: true, conflicts: [], output }
  }
  await resetCheckout(git)
  return { ok: false, conflicts, output }
}

/** Whether the patch is already in the checkout: its reverse applies cleanly. */
export async function reverseApplies(git: Git, files: SourceFile[]): Promise<boolean> {
  const patch = formatPatch(files.filter((file) => !file.binary))
  if (!patch.trim()) return false
  const result = await withTempFile(patch, (path) =>
    git.run('apply', '--reverse', '--check', '--whitespace=nowarn', path),
  )
  return result.exitCode === 0
}

/** Outcome of the patch step. */
export type PatchOutcome =
  | { applied: true; method: 'clean' | 'remapped'; remapped: PathMapping[]; skipped: string[] }
  | { applied: false; conflicts: string[]; output: string; remapped: PathMapping[] }

/** Applies the source patch to a writable checkout; replaceable. */
export interface PatchApplier {
  /** Leaves the checkout clean when it returns `applied: false`. */
  apply(input: {
    dir: string
    runner: CommandRunner
    files: SourceFile[]
    signal?: AbortSignal
  }): Promise<PatchOutcome>
}

/**
 * Tries `git apply --3way` with the source paths, then with paths remapped to files of the same
 * name elsewhere in the target. Binary files without a git binary patch are reported as skipped.
 */
export const defaultPatchApplier: PatchApplier = {
  async apply({ dir, runner, files, signal }) {
    const git = gitIn(dir, runner, signal)
    const skipped = files.filter((file) => !patchable(file)).map((file) => file.newPath)
    const first = await applyFiles(git, files)
    if (first.ok) return { applied: true, method: 'clean', remapped: [], skipped }
    const remapped = remapPaths(files, await trackedFiles(git))
    if (remapped.length === 0)
      return { applied: false, conflicts: first.conflicts, output: first.output, remapped }
    const second = await applyFiles(git, remapFiles(files, remapped))
    if (second.ok) return { applied: true, method: 'remapped', remapped, skipped }
    return {
      applied: false,
      conflicts: [...new Set([...first.conflicts, ...second.conflicts])],
      output: [first.output, second.output].join('\n'),
      remapped,
    }
  },
}
