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

/** Files larger than this are not searched. */
const MAX_FILE_BYTES = 1_000_000

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

/** Text of a searchable file, or `undefined` for large or binary files. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined
    const text = await Bun.file(path).text()
    return text.slice(0, 8000).includes('\0') ? undefined : text
  } catch {
    return undefined
  }
}

/** The lines of `text` without a trailing empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}
