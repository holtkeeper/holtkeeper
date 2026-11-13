import { realpathSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Directories never walked: dependencies, VCS data and build output. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.next',
  '.turbo',
  '.cache',
])

/** Files larger than this are not searched; `code.read` still reads them in slices. */
export const MAX_FILE_BYTES = 1_000_000

/** Files larger than this are not read at all. */
export const MAX_READ_BYTES = 32_000_000

/** Lockfile names; agents query them with `lockfiles.resolve` instead of searching them. */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'go.sum',
]

const MAX_FILES = 50_000

function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realpath(parent), basename(path))
  }
}

/**
 * The absolute path of `path` (relative to `dir` or absolute) after checking that it stays inside
 * `dir` with symlinks resolved. Throws for anything outside.
 */
export function insideDir(dir: string, path: string): string {
  const target = resolve(dir, path)
  const rel = relative(realpath(dir), realpath(target))
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel)))
    throw new Error(`${path} is outside the working directory`)
  return target
}

/** `path` relative to `dir` in `/` spelling. */
export function relativePath(dir: string, path: string): string {
  return relative(dir, path).split(sep).join('/')
}

export interface ListOptions {
  /** Glob patterns relative to the directory; a file must match one of them. */
  globs?: readonly string[]
  /** Lower-case extensions with the dot, e.g. `.ts`; a file must have one of them. */
  extensions?: readonly string[]
  signal?: AbortSignal
}

/**
 * Files under `dir` (relative, `/`-separated, sorted), skipping `IGNORED_DIRECTORIES`, hidden
 * directories and symlinks.
 */
export async function listFiles(dir: string, options: ListOptions = {}): Promise<string[]> {
  const globs = options.globs?.length ? options.globs.map((glob) => new Bun.Glob(glob)) : undefined
  const extensions = options.extensions ? new Set(options.extensions) : undefined
  const files: string[] = []
  const walk = async (rel: string): Promise<void> => {
    options.signal?.throwIfAborted()
    if (files.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(path)
      } else if (entry.isFile()) {
        if (extensions && !extensions.has(extensionOf(entry.name))) continue
        if (globs && !globs.some((glob) => glob.match(path))) continue
        files.push(path)
      }
    }
  }
  await walk('')
  return files.toSorted()
}

/** Lower-case extension with the dot, or `''`. */
export function extensionOf(file: string): string {
  const name = basename(file)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** A file's text, or why it was not read (with its size in bytes when it exists). */
export type FileText =
  | { text: string; size: number }
  | { skipped: 'missing' | 'binary' | 'large'; size: number }

/** The text of the file at `path` when it is a text file of at most `maxBytes`. */
export async function readFileText(path: string, maxBytes = MAX_FILE_BYTES): Promise<FileText> {
  let size = 0
  try {
    const info = await stat(path)
    if (!info.isFile()) return { skipped: 'missing', size: 0 }
    size = info.size
    if (size > maxBytes) return { skipped: 'large', size }
    const text = await Bun.file(path).text()
    return text.slice(0, 8000).includes('\0') ? { skipped: 'binary', size } : { text, size }
  } catch {
    return { skipped: 'missing', size }
  }
}

/** Text of a searchable file, or `undefined` for large or binary files. */
export async function readText(path: string): Promise<string | undefined> {
  const read = await readFileText(path)
  return 'text' in read ? read.text : undefined
}

/** `1.4 MB`, `820 KB`, `12 B`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}

/** Whether `path` is a lockfile by its base name. */
export const isLockfile = (path: string) => LOCKFILE_NAMES.includes(basename(path))

/**
 * One line telling the agent which files a search left out for size, with what to use instead;
 * `''` when none were.
 */
export function skippedForSize(files: readonly { path: string; size: number }[]): string {
  if (files.length === 0) return ''
  const shown = files
    .slice(0, 5)
    .map((file) => `${file.path} (${formatSize(file.size)})`)
    .join(', ')
  const more = files.length > 5 ? ` and ${files.length - 5} more` : ''
  const hint = files.some((file) => isLockfile(file.path))
    ? 'query lockfiles with lockfiles.resolve instead, read other files in parts with code.read'
    : 'read them in parts with code.read'
  return `not searched: ${files.length} ${files.length === 1 ? 'file' : 'files'} over ${formatSize(MAX_FILE_BYTES)}: ${shown}${more}; ${hint}`
}

/** The lines of `text` without a trailing empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}
