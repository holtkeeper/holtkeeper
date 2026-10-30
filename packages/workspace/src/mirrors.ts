import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** One bare mirror in the cache directory. */
export interface MirrorInfo {
  /** Directory name, see `mirrorName`. */
  name: string
  bytes: number
  /** Last clone or fetch, from the mirror's `FETCH_HEAD` (or `HEAD`) modification time. */
  lastUsedAt: Date
}

/** Total size of a directory tree in bytes; symbolic links count as themselves. */
export async function directorySize(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path).catch(() => [] as string[]))
    total += await directorySize(join(path, entry))
  return total
}

const modified = (path: string) =>
  stat(path).then(
    (info) => info.mtime,
    () => undefined,
  )

/** The bare mirrors `checkout` keeps in `cacheDir`, largest first; empty when it does not exist. */
export async function listMirrors(cacheDir: string): Promise<MirrorInfo[]> {
  const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
  const mirrors: MirrorInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue
    const dir = join(cacheDir, entry.name)
    const lastUsedAt =
      (await modified(join(dir, 'FETCH_HEAD'))) ?? (await modified(join(dir, 'HEAD')))
    if (!lastUsedAt) continue
    mirrors.push({ name: entry.name, bytes: await directorySize(dir), lastUsedAt })
  }
  return mirrors.toSorted((a, b) => b.bytes - a.bytes)
}

export interface PruneMirrorsOptions {
  /** Removes mirrors not fetched for this many days; `0` removes all of them. */
  unusedForDays: number
  /** Default `() => new Date()`. */
  now?: () => Date
}

/**
 * Deletes mirrors not used for `unusedForDays`; the next checkout clones them again. Do not run
 * it while jobs use the cache: a running checkout's worktree would lose its object store.
 */
export async function pruneMirrors(
  cacheDir: string,
  options: PruneMirrorsOptions,
): Promise<{ removed: string[]; bytes: number }> {
  const cutoff = (options.now?.() ?? new Date()).getTime() - options.unusedForDays * 86_400_000
  const removed: string[] = []
  let bytes = 0
  for (const mirror of await listMirrors(cacheDir)) {
    if (options.unusedForDays > 0 && mirror.lastUsedAt.getTime() >= cutoff) continue
    await rm(join(cacheDir, mirror.name), { recursive: true, force: true })
    removed.push(mirror.name)
    bytes += mirror.bytes
  }
  return { removed, bytes }
}

/**
 * The mirror cache as a storage provider (the `StorageProvider` shape of `@holtkeeper/artifacts`):
 * one detail per mirror; `clear(scope)` prunes mirrors unused for `scope` days, all when omitted.
 */
export function mirrorStorage(cacheDir: string) {
  return {
    id: 'git-mirrors',
    label: 'Git mirrors',
    async usage() {
      const mirrors = await listMirrors(cacheDir)
      return {
        bytes: mirrors.reduce((sum, mirror) => sum + mirror.bytes, 0),
        count: mirrors.length,
        details: mirrors.map(({ name, bytes }) => ({ label: name, bytes })),
      }
    },
    async clear(scope?: string) {
      const days = scope === undefined ? 0 : Number(scope)
      if (!Number.isFinite(days) || days < 0)
        throw new Error(`scope must be a number of days: ${scope}`)
      const { removed, bytes } = await pruneMirrors(cacheDir, { unusedForDays: days })
      return { removed: removed.length, bytes }
    },
  }
}
