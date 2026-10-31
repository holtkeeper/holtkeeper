import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type BuildProjectOptions, buildProject } from './build.ts'
import {
  APP,
  type AssetKind,
  type BundleAsset,
  type BundleData,
  type BundleEntrypoint,
  type BundlePackage,
  type Contribution,
  type Sizes,
  UNMAPPED,
} from './data.ts'
import { type EntrypointResolver, firstEntrypoints, followImports } from './entrypoints.ts'
import { listFiles } from './files.ts'
import { findSourceMap, measure } from './measure.ts'
import { assetKind, normalizeAssetNames } from './names.ts'
import { type SourceOrigin, sourceOrigin } from './origin.ts'
import {
  type ExplicitEntry,
  explicitResolver,
  htmlResolver,
  importGraphResolver,
  viteManifestResolver,
  webpackStatsResolver,
} from './resolvers.ts'
import { attributeSourceMap } from './sourcemap.ts'

/** Files that describe the build rather than ship with it. */
export const defaultIgnore = [
  '**/*.map',
  '.vite/**',
  '**/stats.json',
  '**/webpack-stats/**',
  'asset-manifest.json',
]

/** Resolvers tried in order when no entries or resolver are given. */
export const defaultResolvers = (): EntrypointResolver[] => [
  viteManifestResolver(),
  webpackStatsResolver(),
  htmlResolver(),
  importGraphResolver(),
]

export interface AnalyzeBundleOptions {
  /** Build output directory; relative paths resolve against `build.dir` when building. */
  dist: string
  /** Project root that app module paths are reported relative to. Default `build.dir` or the parent of `dist`. */
  root?: string
  /** Entrypoints from configuration; replaces the default resolvers. */
  entries?: ExplicitEntry[]
  /** Custom entrypoint resolution; wins over `entries`. */
  resolver?: EntrypointResolver
  /** Globs relative to `dist` to leave out, added to `defaultIgnore`. */
  ignore?: string[]
  /** Follow ES module imports from resolved entry files. Default `true`. */
  followImports?: boolean
  /** Asset name used to match files across builds. Default `normalizeAssetNames` over the build. */
  normalizeName?: (file: string) => string
  /** Bundler name to record instead of the detected one. */
  tool?: string
  /** Runs the build first. */
  build?: BuildProjectOptions
}

interface Measured {
  asset: BundleAsset
  origins: { origin: SourceOrigin; bytes: number }[]
  unmapped: number
  firstSource?: SourceOrigin
}

const runtimes = new Set(['vite', 'webpack', '(virtual)'])
const isCode = (kind: AssetKind) => kind === 'js' || kind === 'css'
const zero = (): Sizes => ({ raw: 0, gzip: 0, brotli: 0 })
const byBytes = (a: Contribution, b: Contribution) =>
  b.bytes - a.bytes || a.name.localeCompare(b.name)

interface Roots {
  dist: string
  realDist: string
  roots: string[]
}

const ups = (path: string) => path.split('/').filter((part) => part === '..').length

function originOf(source: string, mapDir: string, { dist, realDist, roots }: Roots): SourceOrigin {
  const direct = sourceOrigin(source)
  if (runtimes.has(direct.package) || /^(?!file:)[a-z][\w+.-]*:/i.test(source)) return direct
  let path = source
  if (path.startsWith('file:')) {
    try {
      path = fileURLToPath(path)
    } catch {}
  }
  // Bundlers mix real and symlinked paths (macOS `/var` vs `/private/var`), so try both and keep
  // the candidate that stays closest to the project root.
  const mapDirs = [mapDir, realDist + mapDir.slice(dist.length)]
  const absolutes = isAbsolute(path) ? [path] : mapDirs.map((dir) => resolve(dir, path))
  const candidates = absolutes.flatMap((absolute) =>
    roots.map((root) => relative(root, absolute).replaceAll('\\', '/')),
  )
  const best = candidates.toSorted((a, b) => ups(a) - ups(b) || a.length - b.length)[0]
  return sourceOrigin(best ?? path)
}

interface Totals {
  packages: Map<string, Contribution>
  modules: Map<string, Contribution>
}

function add(map: Map<string, Contribution>, name: string, bytes: number, gzip: number) {
  const entry = map.get(name) ?? { name, bytes: 0, gzip: 0 }
  entry.bytes += bytes
  entry.gzip += gzip
  map.set(name, entry)
}

function accumulate(items: Measured[], into: Totals) {
  for (const item of items) {
    if (!isCode(item.asset.kind) || item.asset.raw === 0) continue
    const ratio = item.asset.gzip / item.asset.raw
    for (const { origin, bytes } of item.origins) {
      add(into.packages, origin.package, bytes, bytes * ratio)
      if (origin.package === APP) add(into.modules, origin.path, bytes, bytes * ratio)
    }
    if (item.unmapped) add(into.packages, UNMAPPED, item.unmapped, item.unmapped * ratio)
  }
}

const finish = (map: Map<string, Contribution>) =>
  [...map.values()]
    .map((entry) => Object.assign(entry, { gzip: Math.round(entry.gzip) }))
    .toSorted(byBytes)

const sum = (items: Measured[]) =>
  items.reduce((total, { asset }) => {
    total.raw += asset.raw
    total.gzip += asset.gzip
    total.brotli += asset.brotli
    return total
  }, zero())

async function readVersion(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' &&
      parsed &&
      'version' in parsed &&
      typeof parsed.version === 'string'
      ? parsed.version
      : undefined
  } catch {
    return undefined
  }
}

const labelOf = (origin: SourceOrigin) => (origin.package === APP ? origin.path : origin.package)

/** Measures a build: assets, entrypoints, and which packages and app modules make up their size. */
export async function analyzeBundle(options: AnalyzeBundleOptions): Promise<BundleData> {
  const build = options.build ? await buildProject(options.build) : undefined
  const distDir = options.build ? resolve(options.build.dir, options.dist) : resolve(options.dist)
  const root = resolve(options.root ?? options.build?.dir ?? dirname(distDir))
  const roots: Roots = {
    dist: distDir,
    realDist: await realpath(distDir),
    roots: [...new Set([root, await realpath(root).catch(() => root)])],
  }
  const ignore = [...defaultIgnore, ...(options.ignore ?? [])].map((glob) => new Bun.Glob(glob))

  const allFiles = await listFiles(distDir)
  const present = new Set(allFiles)
  const shipped = allFiles.filter(
    (file) =>
      !ignore.some((glob) => glob.match(file)) &&
      !(/\.(?:gz|br)$/.test(file) && present.has(file.replace(/\.(?:gz|br)$/, ''))),
  )
  const learnedNames = options.normalizeName ? undefined : normalizeAssetNames(shipped)
  const normalize = (file: string) =>
    options.normalizeName?.(file) ?? learnedNames?.get(file) ?? file

  let sawWebpackSource = false
  let sawViteRuntime = false
  let sawBunBanner = false
  const measured = await Promise.all(
    shipped.map(async (file): Promise<Measured> => {
      const path = join(distDir, file)
      const content = new Uint8Array(await Bun.file(path).arrayBuffer())
      const kind = assetKind(file)
      const sizes = await measure(content)
      const result: Measured = {
        asset: { file, name: normalize(file), kind, ...sizes, mapped: 0 },
        origins: [],
        unmapped: isCode(kind) ? sizes.raw : 0,
      }
      if (!isCode(kind)) return result
      const code = new TextDecoder().decode(content)
      if (code.startsWith('// @bun')) sawBunBanner = true
      const found = await findSourceMap(path, code)
      if (!found) return result
      const attribution = attributeSourceMap(code, found.map)
      for (const [source, bytes] of attribution.bySource) {
        if (source.startsWith('webpack://')) sawWebpackSource = true
        const origin = originOf(source, found.dir, roots)
        if (origin.package === 'vite') sawViteRuntime = true
        result.origins.push({ origin, bytes })
      }
      const first = found.map.sources?.find((source) => typeof source === 'string')
      if (first)
        result.firstSource = originOf((found.map.sourceRoot ?? '') + first, found.dir, roots)
      result.unmapped = attribution.unmapped
      result.asset.mapped = sizes.raw - attribution.unmapped
      return result
    }),
  )

  const byName = new Map<string, Measured[]>()
  for (const item of measured)
    byName.set(item.asset.name, [...(byName.get(item.asset.name) ?? []), item])
  for (const group of byName.values()) {
    if (group.length < 2) continue
    for (const item of group) {
      item.asset.name = item.firstSource
        ? `${item.asset.name} [${labelOf(item.firstSource)}]`
        : item.asset.file
    }
    const names = new Set<string>()
    for (const item of group) {
      if (names.has(item.asset.name)) item.asset.name = item.asset.file
      names.add(item.asset.name)
    }
  }

  const chain = firstEntrypoints(...defaultResolvers())
  const resolver = options.resolver ?? (options.entries ? explicitResolver(options.entries) : chain)
  const files = new Set(shipped)
  let resolved = (await resolver.resolve(distDir)) ?? []
  if (options.followImports !== false) resolved = await followImports(distDir, resolved, files)
  const matched = resolver === chain ? chain.matched : resolver

  const assets = new Map(measured.map((item) => [item.asset.file, item]))
  const versionCache = new Map<string, Promise<string | undefined>>()
  const versionOf = (installPath: string) => {
    let version = versionCache.get(installPath)
    if (!version) {
      version = readVersion(join(root, installPath, 'package.json'))
      versionCache.set(installPath, version)
    }
    return version
  }

  const packageEntrypoints = new Map<string, Set<string>>()
  const entrypoints: BundleEntrypoint[] = resolved.map((entry) => {
    const initial = entry.initial.filter((file) => assets.has(file))
    const lazy = entry.lazy.filter((file) => assets.has(file) && !initial.includes(file))
    const initialItems = initial.flatMap((file) => assets.get(file) ?? [])
    const lazyItems = lazy.flatMap((file) => assets.get(file) ?? [])
    const totals: Totals = { packages: new Map(), modules: new Map() }
    accumulate([...initialItems, ...lazyItems], totals)
    for (const name of totals.packages.keys()) {
      packageEntrypoints.set(name, (packageEntrypoints.get(name) ?? new Set()).add(entry.name))
    }
    return {
      name: entry.name,
      initial,
      lazy,
      initialSize: sum(initialItems),
      lazySize: sum(lazyItems),
      packages: finish(totals.packages),
      modules: finish(totals.modules),
    }
  })

  const overall: Totals = { packages: new Map(), modules: new Map() }
  accumulate(measured, overall)
  const details = new Map<
    string,
    { versions: Set<string>; instances: Set<string>; modules: Set<string> }
  >()
  for (const item of measured) {
    for (const { origin } of item.origins) {
      if (origin.package === APP) continue
      const detail = details.get(origin.package) ?? {
        versions: new Set(),
        instances: new Set(),
        modules: new Set(),
      }
      details.set(origin.package, detail)
      detail.modules.add(`${origin.installPath ?? ''}/${origin.path}`)
      if (origin.installPath) detail.instances.add(origin.installPath)
      const version =
        origin.version ?? (origin.installPath ? await versionOf(origin.installPath) : undefined)
      if (version) detail.versions.add(version)
    }
  }
  const packages: BundlePackage[] = finish(overall.packages)
    .filter((entry) => entry.name !== APP && entry.name !== UNMAPPED)
    .map((entry) => {
      const detail = details.get(entry.name)
      return {
        ...entry,
        versions: [...(detail?.versions ?? [])].toSorted(),
        instances: [...(detail?.instances ?? [])].toSorted(),
        modules: detail?.modules.size ?? 0,
        entrypoints: [...(packageEntrypoints.get(entry.name) ?? [])].toSorted(),
      }
    })

  const tool =
    options.tool ??
    matched?.tool ??
    (sawWebpackSource ? 'webpack' : sawViteRuntime ? 'vite' : sawBunBanner ? 'bun' : undefined)

  return {
    ...(tool ? { tool } : {}),
    ...(build ? { build: { command: build.command, durationMs: build.durationMs } } : {}),
    assets: measured.map((item) => item.asset).toSorted((a, b) => a.file.localeCompare(b.file)),
    entrypoints,
    packages,
    modules: finish(overall.modules),
    unmapped: overall.packages.get(UNMAPPED)?.bytes ?? 0,
  }
}
