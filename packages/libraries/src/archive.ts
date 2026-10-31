import { safeArchivePath } from '@holtkeeper/artifacts'

import type { ArchiveFiles } from './types.ts'

/** Options of `readTarball`. */
export interface TarballOptions {
  /** Drop the first path segment (`package/` of npm tarballs, `owner-repo-sha/` of GitHub ones). */
  stripTop?: boolean
  /** Keep only paths (after stripping) this accepts. */
  keep?: (path: string) => boolean
  /** Files larger than this are skipped. Default 2 MB. */
  maxFileBytes?: number
  /** Files are read until their sizes add up to this; the rest are skipped. Default 64 MB. */
  maxTotalBytes?: number
  /** Skip files that look binary (a NUL byte in the first 8 KB). Default `true`. */
  textOnly?: boolean
}

/** Whether `data` looks like text: no NUL byte in its first 8 KB. */
export function isText(data: Uint8Array): boolean {
  const end = Math.min(data.length, 8192)
  for (let i = 0; i < end; i++) if (data[i] === 0) return false
  return true
}

/**
 * The regular files of a tar or gzipped tar archive by relative path, with `/` separators. Unsafe
 * paths (absolute, `..`) are skipped, never resolved. Throws when the bytes are not an archive.
 */
export async function readTarball(
  bytes: Uint8Array,
  options: TarballOptions = {},
): Promise<ArchiveFiles> {
  const maxFile = options.maxFileBytes ?? 2_000_000
  let budget = options.maxTotalBytes ?? 64_000_000
  const textOnly = options.textOnly ?? true
  const entries = await new Bun.Archive(bytes).files()
  const files: ArchiveFiles = new Map()
  for (const [name, file] of [...entries].toSorted(([a], [b]) => a.localeCompare(b))) {
    let path: string
    try {
      path = safeArchivePath(name)
    } catch {
      continue
    }
    if (options.stripTop) {
      const slash = path.indexOf('/')
      if (slash < 0) continue
      path = path.slice(slash + 1)
    }
    if (!path || path.endsWith('/')) continue
    if (options.keep && !options.keep(path)) continue
    if (file.size > maxFile || file.size > budget) continue
    // oxlint-disable-next-line no-await-in-loop -- entries are already in memory
    const data = await file.bytes()
    if (textOnly && !isText(data)) continue
    budget -= data.length
    files.set(path, data)
  }
  return files
}

/** UTF-8 text of an archive file; `undefined` when absent. */
export const fileText = (files: ArchiveFiles, path: string) => {
  const data = files.get(path)
  return data ? new TextDecoder().decode(data) : undefined
}
