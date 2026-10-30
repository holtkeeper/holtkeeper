import { lstat, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import type { ContainerEngine } from './container.ts'

/** Where mise keeps installed tools for jobs. */
export type MiseCacheOptions =
  | {
      mode: 'container'
      /** Default `docker`. */
      engine?: ContainerEngine
      /** Default `holtkeeper-mise-cache`, the volume `containerRunner` mounts. */
      volume?: string
      /** Image with `du`, used when the engine's `system df` does not report the volume. Default `alpine`. */
      image?: string
      hostRunner: CommandRunner
    }
  | {
      mode: 'host'
      /** Default `MISE_DATA_DIR`, else `~/.local/share/mise`. */
      dataDir?: string
    }

const units: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
}

/** Parses sizes as container engines print them (`1.2GB`, `512kB`, `0B`); `undefined` otherwise. */
export function parseSize(text: string): number | undefined {
  const match = /^\s*([\d.]+)\s*([kmgt]?i?b)\s*$/i.exec(text)
  const unit = match?.[2] && units[match[2].toLowerCase()]
  return match?.[1] && unit ? Math.round(Number(match[1]) * unit) : undefined
}

async function directorySize(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isDirectory()) return info?.size ?? 0
  let total = 0
  for (const entry of await readdir(path).catch(() => [] as string[]))
    total += await directorySize(join(path, entry))
  return total
}

const volumeSizeFromDf = (stdout: string, volume: string): number | undefined => {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      const volumes: unknown =
        typeof parsed === 'object' && parsed !== null && 'Volumes' in parsed ? parsed.Volumes : []
      for (const entry of Array.isArray(volumes) ? (volumes as unknown[]) : []) {
        if (typeof entry !== 'object' || entry === null) continue
        if (!('Name' in entry) || entry.Name !== volume || !('Size' in entry)) continue
        if (typeof entry.Size === 'string') return parseSize(entry.Size)
      }
    } catch {}
  }
  return undefined
}

/** Bytes used by mise's tool cache; `undefined` when the volume or directory does not exist. */
export async function miseCacheSize(options: MiseCacheOptions): Promise<number | undefined> {
  if (options.mode === 'host') {
    const dir = options.dataDir ?? Bun.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise')
    if (!(await lstat(dir).catch(() => undefined))) return undefined
    return directorySize(dir)
  }
  const engine = options.engine ?? 'docker'
  const volume = options.volume ?? 'holtkeeper-mise-cache'
  const run = { cwd: tmpdir(), timeoutMs: 120_000 }
  const inspect = await options.hostRunner.run([engine, 'volume', 'inspect', volume], run)
  if (inspect.exitCode !== 0) return undefined
  const df = await options.hostRunner.run([engine, 'system', 'df', '-v', '--format', 'json'], run)
  const fromDf = df.exitCode === 0 ? volumeSizeFromDf(df.stdout, volume) : undefined
  if (fromDf !== undefined) return fromDf
  const du = await runChecked(
    options.hostRunner,
    [
      engine,
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${volume}:/v:ro`,
      options.image ?? 'alpine',
      'du',
      '-sk',
      '/v',
    ],
    run,
  )
  const kilobytes = Number(du.stdout.trim().split(/\s+/)[0])
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined
}

/**
 * The mise tool cache as a storage provider (the `StorageProvider` shape of
 * `@holtkeeper/artifacts`). In container mode `clear()` removes the volume (the engine refuses
 * while a job uses it) and jobs reinstall tools; the host cache is shared with people's own mise
 * and cannot be cleared from here.
 */
export function miseCacheStorage(options: MiseCacheOptions) {
  const usage = async () => {
    const bytes = await miseCacheSize(options)
    return bytes === undefined
      ? { bytes: 0, available: false, note: 'no mise cache yet' }
      : {
          bytes,
          note:
            options.mode === 'container'
              ? `volume ${options.volume ?? 'holtkeeper-mise-cache'}`
              : 'host MISE_DATA_DIR',
        }
  }
  if (options.mode === 'host') return { id: 'mise-cache', label: 'Tool cache (mise)', usage }
  return {
    id: 'mise-cache',
    label: 'Tool cache (mise)',
    usage,
    async clear() {
      const bytes = await miseCacheSize(options)
      if (bytes === undefined) return { removed: 0, bytes: 0 }
      await runChecked(
        options.hostRunner,
        [options.engine ?? 'docker', 'volume', 'rm', options.volume ?? 'holtkeeper-mise-cache'],
        { cwd: tmpdir(), timeoutMs: 120_000 },
      )
      return { removed: 1, bytes }
    },
  }
}
