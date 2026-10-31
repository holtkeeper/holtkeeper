import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { analyzeBundle } from './analyze.ts'
import type { Entrypoint, EntrypointResolver } from './entrypoints.ts'
import { entryNameOf } from './files.ts'
import { importGraphResolver } from './resolvers.ts'
import type { BundleTarget, PackageInfo } from './targets.ts'

/** Files of a package archive that never reach a bundle, left out of its assets. */
export const packageIgnore = [
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/*.d.ts.map',
  '**/*.md',
  '**/*.markdown',
  '**/*.tsbuildinfo',
  '**/LICEN[CS]E*',
  '**/CHANGELOG*',
  'package.json',
]

/** Conditions of `exports` a bundler for browsers picks, most preferred first. */
const conditions = ['browser', 'import', 'module', 'default', 'require', 'node']

const MAX_ENTRIES = 100

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function pick(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pick(item)
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const key of conditions) {
    const found = key in value ? pick(value[key]) : undefined
    if (found) return found
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'types' || key === 'typings' || conditions.includes(key)) continue
    const found = pick(item)
    if (found) return found
  }
  return undefined
}

const clean = (path: string) => path.replace(/^\.\//, '')

function existing(target: string, files: ReadonlySet<string>): string | undefined {
  const path = clean(target)
  return [path, `${path}.js`, `${path}.mjs`, `${path}/index.js`, `${path}/index.mjs`].find(
    (candidate) => files.has(candidate),
  )
}

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * Entry files of a package by subpath: what a browser bundler resolves for each `exports`
 * subpath (conditions `browser`, `import`, `module`, `default`, `require`, `node`; never `types`),
 * then `*` patterns expanded over the archive, at most 100 in all. Without `exports`: `module`, a string
 * `browser`, `main`, else `index.js`. Subpaths whose file is missing are left out.
 */
export function packageEntries(
  manifest: Record<string, unknown>,
  files: ReadonlySet<string>,
): Entrypoint[] {
  const entries: Entrypoint[] = []
  const add = (name: string, target: string | undefined) => {
    const file = target ? existing(target, files) : undefined
    if (file && entries.length < MAX_ENTRIES) entries.push({ name, initial: [file], lazy: [] })
  }
  const exports = manifest['exports']
  if (exports !== undefined && exports !== null) {
    const map =
      isRecord(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
        ? exports
        : { '.': exports }
    const patterns: [string, string][] = []
    for (const [subpath, value] of Object.entries(map)) {
      if (!subpath.startsWith('.') || subpath === './package.json') continue
      const target = pick(value)
      if (!target) continue
      if (subpath.includes('*') && target.includes('*')) patterns.push([subpath, target])
      else add(subpath, target)
    }
    for (const [subpath, target] of patterns) {
      const pattern = new RegExp(`^${escape(clean(target)).replace('*', '(.+)')}$`)
      for (const file of files) {
        const match = pattern.exec(file)?.[1]
        if (match !== undefined) add(subpath.replace('*', match), file)
      }
    }
    return entries
  }
  const browser = typeof manifest['browser'] === 'string' ? manifest['browser'] : undefined
  const main = [manifest['module'], browser, manifest['main'], 'index.js'].find(
    (value): value is string => typeof value === 'string' && existing(value, files) !== undefined,
  )
  add('.', main)
  return entries
}

/**
 * `packageEntries`, or for packages that declare no entry and ship no `index.js` (imported by
 * deep paths such as `pkg/useThing`) every JS module no other module of the package imports.
 */
export const packageResolver = (
  manifest: Record<string, unknown>,
  files: ReadonlySet<string>,
): EntrypointResolver => ({
  name: 'package-exports',
  async resolve(distDir) {
    const entries = packageEntries(manifest, files)
    if (entries.length) return entries
    const roots = (await importGraphResolver().resolve(distDir)) ?? []
    return roots
      .slice(0, MAX_ENTRIES)
      .map((entry) => ({ ...entry, name: `./${entryNameOf(entry.initial[0] ?? entry.name)}` }))
  },
})

const names = (value: unknown) => (isRecord(value) ? Object.keys(value).toSorted() : [])

/** One published version of a package, unpacked. */
export interface PackageArchiveInput {
  name: string
  version: string
  /** Files of the archive by relative path, without its top folder (`package/` for npm). */
  files: ReadonlyMap<string, Uint8Array>
  /** When the version was published (ISO 8601). */
  publishedAt?: string
}

/**
 * Measures one published package version like a build: its shipped files (no declarations, docs
 * or manifests) as assets, its export subpaths as entrypoints, and source maps it ships for
 * attribution; plus what the whole archive weighs. Never throws: failures become a `failed`
 * target.
 */
export async function analyzePackage(input: PackageArchiveInput): Promise<BundleTarget> {
  const base = {
    name: input.name,
    source: 'package' as const,
    version: input.version,
    ...(input.publishedAt ? { at: input.publishedAt } : {}),
  }
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-package-'))
  try {
    const raw = input.files.get('package.json')
    const manifest: unknown = raw ? JSON.parse(new TextDecoder().decode(raw)) : {}
    const fields = isRecord(manifest) ? manifest : {}
    let unpacked = 0
    for (const [path, data] of input.files) {
      unpacked += data.length
      const target = join(dir, path)
      // oxlint-disable-next-line no-await-in-loop -- archive files are few and written in order
      await mkdir(dirname(target), { recursive: true })
      // oxlint-disable-next-line no-await-in-loop -- see above
      await writeFile(target, data)
    }
    const files = new Set(input.files.keys())
    const data = await analyzeBundle({
      dist: dir,
      root: dir,
      ignore: packageIgnore,
      resolver: packageResolver(fields, files),
    })
    const info: PackageInfo = {
      unpacked,
      files: input.files.size,
      dependencies: names(fields['dependencies']),
      peerDependencies: names(fields['peerDependencies']),
    }
    return { ...base, status: 'ok', data, package: info }
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
