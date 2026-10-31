import { mkdir, open, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

export interface MirrorLockOptions {
  /** A lock not refreshed for this long is taken over. Default 5 minutes. */
  staleMs?: number
  /** How often the holder refreshes it. Default 30 seconds. */
  refreshMs?: number
  /** Default 250 ms. */
  pollMs?: number
  signal?: AbortSignal
}

const missing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

/**
 * Runs `task` while holding `<mirror>.lock`, created with `O_EXCL`, so processes on other hosts
 * sharing the cache directory (an NFS or other ReadWriteMany volume) never run git in one mirror
 * at once. The holder refreshes the file; a lock left by a killed process is taken over once
 * stale. While holding it, git's own `*.lock` files in the mirror can only be leftovers of a
 * killed git and are removed first.
 */
export async function withMirrorLock<T>(
  mirror: string,
  task: () => Promise<T>,
  options: MirrorLockOptions = {},
): Promise<T> {
  const path = `${mirror}.lock`
  const staleMs = options.staleMs ?? 300_000
  const owner = `${hostname()} ${process.pid} ${crypto.randomUUID()}`
  await mkdir(dirname(path), { recursive: true })
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(owner)
      await handle.close()
      break
    } catch (error) {
      if (
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')
      )
        throw error
    }
    const info = await stat(path).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs > staleMs) {
      await rm(path, { force: true })
      continue
    }
    await Bun.sleep(options.pollMs ?? 250)
  }
  const refresh = setInterval(() => {
    const now = new Date()
    utimes(path, now, now).catch(() => undefined)
  }, options.refreshMs ?? 30_000)
  try {
    await removeGitLocks(mirror)
    return await task()
  } finally {
    clearInterval(refresh)
    const holder = await readFile(path, 'utf8').catch(() => undefined)
    if (holder === owner) await rm(path, { force: true })
  }
}

/** git's lock files at the top of a mirror and under `refs/`, not those of worktrees. */
async function removeGitLocks(mirror: string): Promise<void> {
  const top = await readdir(mirror).catch((error: unknown) => {
    if (missing(error)) return [] as string[]
    throw error
  })
  for (const name of top) if (name.endsWith('.lock')) await rm(join(mirror, name), { force: true })
  const refs = await readdir(join(mirror, 'refs'), { recursive: true }).catch(() => [] as string[])
  for (const name of refs)
    if (name.endsWith('.lock')) await rm(join(mirror, 'refs', name), { force: true })
}
