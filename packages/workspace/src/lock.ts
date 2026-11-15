import { mkdir, open, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

export interface MirrorLockOptions {
  /** A lock not refreshed for this long is taken over. Default 5 minutes. */
  staleMs?: number
  /** How often the holder refreshes it. Default 30 seconds. */
  refreshMs?: number
  /**
   * The holder stops refreshing after this long, so a task that hangs cannot keep the mirror from
   * every other process forever: once stale, the lock is taken over. Default 60 minutes.
   */
  maxHoldMs?: number
  /** Default 250 ms. */
  pollMs?: number
  /** Stops waiting for the lock; a task already holding it is not interrupted. */
  signal?: AbortSignal
  /** Told once when the lock is busy and when a holder gives up refreshing it. */
  log?: (line: string) => void
}

const missing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const exists = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Runs `task` while holding `<mirror>.lock`, created with `O_EXCL`, so no two tasks run git in one
 * mirror at once, whether they are in this process or on other hosts sharing the cache directory
 * (an NFS or other ReadWriteMany volume). The holder refreshes the file for at most `maxHoldMs`;
 * a lock left by a killed or hung holder is taken over once stale. While holding it, git's own
 * `*.lock` files in the mirror can only be leftovers of a killed git and are removed first.
 * Waiting ends with the signal's reason when `signal` aborts.
 */
export async function withMirrorLock<T>(
  mirror: string,
  task: () => Promise<T>,
  options: MirrorLockOptions = {},
): Promise<T> {
  const path = `${mirror}.lock`
  const { signal, log } = options
  const staleMs = options.staleMs ?? 300_000
  const maxHoldMs = options.maxHoldMs ?? 3_600_000
  const owner = `${hostname()} ${process.pid} ${crypto.randomUUID()}`
  await mkdir(dirname(path), { recursive: true })
  let told = false
  for (;;) {
    signal?.throwIfAborted()
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(owner)
      await handle.close()
      break
    } catch (error) {
      if (!exists(error)) throw error
    }
    const info = await stat(path).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs > staleMs) {
      await rm(path, { force: true })
      continue
    }
    if (!told && log) {
      told = true
      const holder = await readFile(path, 'utf8').catch(() => '')
      log(
        `waiting for the mirror lock${holder ? ` held by ${holder.split(' ', 2).join(' pid ')}` : ''}`,
      )
    }
    await sleep(options.pollMs ?? 250, signal)
  }
  const acquired = Date.now()
  const refresh = setInterval(() => {
    if (Date.now() - acquired > maxHoldMs) {
      clearInterval(refresh)
      log?.(
        `the mirror lock is held for over ${Math.round(maxHoldMs / 60_000)} min; no longer refreshing it so other jobs can take it over`,
      )
      return
    }
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
