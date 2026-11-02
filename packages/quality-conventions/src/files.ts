import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { QualityContext } from '@holtkeeper/quality'

type CommandRunner = QualityContext['runner']

/** Directories never walked when the project is not a git repository. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'vendor',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
])

/**
 * Files of the project, relative to `dir` with `/` separators. In a git work tree this is what
 * git tracks plus untracked files that are not ignored; otherwise a walk that skips
 * `SKIPPED_DIRECTORIES` and dot directories.
 */
export async function listFiles(
  dir: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<string[]> {
  const fromGit = await gitFiles(dir, runner, signal)
  if (fromGit) return fromGit
  const files: string[] = []
  for await (const file of walkFiles(dir)) files.push(file)
  return files
}

async function gitFiles(
  dir: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  try {
    const result = await runner.run(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: dir,
        ...(signal ? { signal } : {}),
      },
    )
    if (result.exitCode !== 0) return undefined
    return [...new Set(result.stdout.split('\0').filter(Boolean))]
  } catch {
    return undefined
  }
}

/** Walks `dir` lazily, skipping `SKIPPED_DIRECTORIES` and dot directories. */
export async function* walkFiles(dir: string, prefix = ''): AsyncGenerator<string> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true })
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name))
        yield* walkFiles(dir, path)
    } else if (entry.isFile()) yield path
  }
}

const GENERATED_PATH =
  /(?:^|\/)(?:generated|__generated__)\/|\.pb\.\w+$|_pb2?(?:_grpc)?\.\w+$|\.generated\.\w+$|\.gen\.\w+$/
const GENERATED_HEADER =
  /@generated\b|Code generated .* DO NOT EDIT|\bDO NOT EDIT\b|auto-?generated/i

/**
 * Whether a file is generated code: it lives under `generated/`, has a generator's name
 * (`*.pb.go`, `*_pb.ts`, `*.generated.ts`) or says so in its first lines (`Code generated ...
 * DO NOT EDIT.`, `@generated`). Its names follow the generator, not the project.
 */
export function isGenerated(path: string, text: string): boolean {
  return GENERATED_PATH.test(path) || GENERATED_HEADER.test(text.slice(0, 1024))
}
