import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CommandResult, CommandRunner } from '@holtkeeper/exec'

/** Git in one checkout; `run` resolves for any exit code. */
export interface Git {
  dir: string
  run(...args: string[]): Promise<CommandResult>
}

/** Binds `git -c core.quotepath=off` to `dir`. */
export function gitIn(dir: string, runner: CommandRunner, signal?: AbortSignal): Git {
  return {
    dir,
    run: (...args) =>
      runner.run(['git', '-c', 'core.quotepath=off', ...args], {
        cwd: dir,
        ...(signal ? { signal } : {}),
      }),
  }
}

/** Tracked files of the checkout. */
export async function trackedFiles(git: Git): Promise<string[]> {
  const result = await git.run('ls-files', '-z')
  return result.stdout.split('\0').filter(Boolean)
}

/** Drops every change in the checkout: tracked files back to `HEAD`, untracked files removed. */
export async function resetCheckout(git: Git): Promise<void> {
  await git.run('reset', '--hard', '-q', 'HEAD')
  await git.run('clean', '-fdq')
}

/** Runs `use` with a temporary directory outside any checkout, removed afterwards. */
export async function withTemp<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-port-'))
  try {
    return await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Writes `text` to a temporary file and runs `use` with its path. */
export function withTempFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T> {
  return withTemp(async (dir) => {
    const path = join(dir, 'content')
    await writeFile(path, text)
    return use(path)
  })
}

/**
 * Exact strings among `needles` that occur in tracked files (`git grep -F`); `words` matches
 * whole words only. Needles are searched in batches to keep command lines short.
 */
export async function grepPresent(
  git: Git,
  needles: string[],
  options: { words?: boolean } = {},
): Promise<Set<string>> {
  const found = new Set<string>()
  for (let start = 0; start < needles.length; start += 40) {
    const batch = needles.slice(start, start + 40)
    // oxlint-disable-next-line no-await-in-loop -- batches share one checkout
    const result = await git.run(
      'grep',
      '-h',
      '-o',
      '-I',
      '-F',
      ...(options.words ? ['-w'] : []),
      ...batch.flatMap((needle) => ['-e', needle]),
    )
    for (const line of result.stdout.split('\n')) if (batch.includes(line)) found.add(line)
  }
  return found
}

/** `git grep -n` lines for whole-word `symbols`, at most `limit` lines. */
export async function grepLocations(git: Git, symbols: string[], limit = 80): Promise<string[]> {
  if (symbols.length === 0) return []
  const result = await git.run(
    'grep',
    '-n',
    '-I',
    '-w',
    '-F',
    ...symbols.slice(0, 40).flatMap((symbol) => ['-e', symbol]),
  )
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line))
}
