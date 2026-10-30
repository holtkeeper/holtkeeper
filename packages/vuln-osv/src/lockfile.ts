import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

const lockfileNames = new Set(['package-lock.json', 'npm-shrinkwrap.json'])
const skipped = new Set(['node_modules', '.git'])

const packageSchema = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  link: z.boolean().optional(),
})

type LockPackage = z.infer<typeof packageSchema>

interface V1Dependency extends LockPackage {
  dependencies?: Record<string, V1Dependency>
}

const v1DependencySchema: z.ZodType<V1Dependency> = z.lazy(() =>
  packageSchema.extend({
    dependencies: z.record(z.string(), v1DependencySchema).optional(),
  }),
)

const lockfileSchema = z.looseObject({
  packages: z.record(z.string(), packageSchema).optional(),
  dependencies: z.record(z.string(), v1DependencySchema).optional(),
})

type Lockfile = z.infer<typeof lockfileSchema>

/** npm lockfiles under `dir`, relative to it, skipping `node_modules` and `.git`. */
async function findNpmLockfiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isFile() && lockfileNames.has(entry.name)) found.push(path)
      // oxlint-disable-next-line no-await-in-loop
      else if (entry.isDirectory() && !skipped.has(entry.name)) await walk(path)
    }
  }
  await walk('')
  return found
}

const registryUrl = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`

const needsResolved = (entry: LockPackage) =>
  !entry.resolved && !entry.link && !!entry.version && !entry.version.startsWith('file:')

function fillV1(dependencies: Record<string, V1Dependency>): number {
  let filled = 0
  for (const [name, entry] of Object.entries(dependencies)) {
    if (needsResolved(entry) && !entry.version?.includes(':')) {
      entry.resolved = registryUrl(name, entry.version ?? '')
      filled++
    }
    if (entry.dependencies) filled += fillV1(entry.dependencies)
  }
  return filled
}

/**
 * Gives every registry package in an npm lockfile a `resolved` URL and returns how many it filled.
 * osv-scanner treats packages without one as local and never looks them up, so a lockfile written
 * with `omit-lockfile-registry-resolved` otherwise scans as clean.
 */
export function fillResolved(lock: Lockfile): number {
  let filled = 0
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/')
    if (at === -1 || !needsResolved(entry)) continue
    entry.resolved = registryUrl(
      entry.name ?? path.slice(at + 'node_modules/'.length),
      entry.version ?? '',
    )
    filled++
  }
  if (!lock.packages && lock.dependencies) filled += fillV1(lock.dependencies)
  return filled
}

/**
 * Runs `scan` while the npm lockfiles under `dir` carry `resolved` URLs for every registry
 * package, then restores each patched file byte for byte, also when `scan` throws.
 */
export async function withResolvedLockfiles<T>(dir: string, scan: () => Promise<T>): Promise<T> {
  const originals = new Map<string, string>()
  try {
    for (const path of await findNpmLockfiles(dir)) {
      const file = join(dir, path)
      // oxlint-disable-next-line no-await-in-loop
      const text = await Bun.file(file).text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        continue
      }
      const parsed = lockfileSchema.safeParse(json)
      if (!parsed.success) continue
      const lock = parsed.data
      if (fillResolved(lock) === 0) continue
      originals.set(file, text)
      // oxlint-disable-next-line no-await-in-loop
      await Bun.write(file, JSON.stringify(lock, null, 2))
    }
    return await scan()
  } finally {
    await Promise.all([...originals].map(([file, text]) => Bun.write(file, text)))
  }
}
