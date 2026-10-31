import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type AnalyzerContext,
  anyOf,
  defineAnalyzer,
  fileContains,
  hasFile,
} from '@holtkeeper/analyzer'
import { findPackages } from '@holtkeeper/api-surface'
import {
  type BundleRecordData,
  type BundleTarget,
  APP_TARGET,
  analyzeBuildTarget,
  analyzePackage,
  bundleAnalysis,
  bundleTargetSchema,
  bundleTargets,
  isBundleAnalysisData,
  targetKey,
} from '@holtkeeper/bundles'
import { installDependencies } from '@holtkeeper/coverage'
import { type LibraryRegistry, npmRegistry } from '@holtkeeper/libraries'
import { z } from 'zod'

const bundlerConfigs = ['vite', 'webpack', 'rspack', 'rsbuild', 'rollup'].flatMap((tool) =>
  ['ts', 'mts', 'js', 'mjs', 'cjs'].map((extension) => `${tool}.config.${extension}`),
)

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const BUILD_TIMEOUT_MS = 20 * 60 * 1000
const DIST_CANDIDATES = ['dist', 'build', 'out']
const CONCURRENCY = 4

const entrySchema = z.object({ name: z.string().min(1), globs: z.array(z.string()).min(1) })

const targetSchema = z.object({
  name: z.string().min(1),
  /** Project folder, relative to the repository root. */
  dir: z.string().default('.'),
  /** Shell command that builds the target; default `<package manager> run build`. */
  build: z.string().optional(),
  /** Build output relative to `dir`; default the first of `dist`, `build`, `out` that exists. */
  dist: z.string().optional(),
  entries: z.array(entrySchema).optional(),
})

const bundleOptions = z.object({
  /**
   * What to measure: `auto` builds apps that have a bundler config and measures packages the
   * repository publishes; `build` and `packages` only one of them.
   */
  source: z.enum(['auto', 'build', 'packages']).default('auto'),
  /** Builds to measure; replaces detection. */
  targets: z.array(targetSchema).default([]),
  /** Shorthand for one `app` target at the root. */
  dist: z.string().optional(),
  build: z.string().optional(),
  /** Install dependencies from the lockfile before building. */
  install: z.boolean().default(true),
  installScripts: z.boolean().default(false),
  /** Globs of package names to measure; empty measures every published package. */
  packages: z.array(z.string()).default([]),
  excludePackages: z.array(z.string()).default([]),
  /** Earlier published versions per package measured on top of the one at the ref. */
  history: z.coerce.number().int().min(0).max(200).default(0),
  includePrereleases: z.boolean().default(false),
  /**
   * Registry per package scope (`@acme`) or `*` for all; wins over `publishConfig.registry`,
   * `.npmrc`, the forge's own registry and npmjs.
   */
  registries: z.record(z.string(), z.string().url()).default({}),
})

type BundleOptions = z.infer<typeof bundleOptions>
type Context = AnalyzerContext<BundleOptions>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const packageManagerOf = (root: string) =>
  existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
    ? 'bun'
    : existsSync(join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(root, 'yarn.lock'))
        ? 'yarn'
        : 'npm'

type BuildTarget = z.infer<typeof targetSchema>

/** Builds to measure: configured, the `dist`/`build` shorthand, or detected. */
async function buildTargets(root: string, options: BundleOptions): Promise<BuildTarget[]> {
  if (options.source === 'packages') return []
  if (options.targets.length) return options.targets
  if (options.dist || options.build)
    return [
      {
        name: APP_TARGET,
        dir: '.',
        ...(options.build ? { build: options.build } : {}),
        ...(options.dist ? { dist: options.dist } : {}),
      },
    ]
  const found: BuildTarget[] = []
  for (const manifest of await findPackages(root)) {
    if (!manifest.private && manifest.dir !== '.') continue
    const dir = join(root, manifest.dir)
    if (!bundlerConfigs.some((file) => existsSync(join(dir, file)))) continue
    // oxlint-disable-next-line no-await-in-loop -- a few manifests, read one after another
    const scripts = (await readJson(join(dir, 'package.json')))['scripts']
    if (!isRecord(scripts) || typeof scripts['build'] !== 'string') continue
    found.push({ name: manifest.dir === '.' ? APP_TARGET : manifest.name, dir: manifest.dir })
  }
  return found
}

async function measureBuilds(context: Context, root: string, targets: BuildTarget[]) {
  const { options, runner, log, signal } = context
  if (!targets.length) return []
  if (options.install) {
    const installed = await installDependencies({
      dir: root,
      runner,
      scripts: options.installScripts,
      ...(signal ? { signal } : {}),
    })
    log?.(
      installed.status === 'failed'
        ? `bundle: install failed: ${installed.error}`
        : `bundle: install ${installed.status}${installed.status === 'skipped' ? ` (${installed.reason})` : ''}`,
    )
  }
  const manager = packageManagerOf(root)
  const results: BundleTarget[] = []
  for (const target of targets) {
    const dir = join(root, target.dir)
    const command = ['sh', '-c', target.build ?? `${manager} run build`]
    log?.(`bundle: building ${target.name} in ${target.dir}: ${command[2]}`)
    // oxlint-disable-next-line no-await-in-loop -- builds share the checkout and run one at a time
    const built = await analyzeBuildTarget({
      name: target.name,
      dir,
      dist: target.dist ?? DIST_CANDIDATES,
      root: dir,
      command,
      runner,
      env: { CI: 'true', NODE_ENV: 'production' },
      timeoutMs: BUILD_TIMEOUT_MS,
      ...(target.entries ? { entries: target.entries } : {}),
      ...(signal ? { signal } : {}),
    })
    if (built.status === 'failed') log?.(`bundle: ${target.name} failed: ${built.error}`)
    results.push(built)
  }
  return results
}

/** `@scope:registry=` and `registry=` lines of an `.npmrc`. */
function npmrcRegistries(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^\s*(?:(@[^:\s]+):)?registry\s*=\s*(\S+)/.exec(line)
    if (match?.[2] && /^https?:\/\//.test(match[2])) found.set(match[1] ?? '*', match[2])
  }
  return found
}

const scopeOf = (name: string) => (name.startsWith('@') ? name.split('/')[0] : undefined)
const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

/**
 * Registries to look for a package in, most specific first: the `registries` option, the
 * package's `publishConfig.registry`, `.npmrc` of the package and the root, the forge's own
 * registry for the repository, npmjs.
 */
async function registryCandidates(
  context: Context,
  root: string,
  dir: string,
  name: string,
): Promise<string[]> {
  const scope = scopeOf(name)
  const pick = (map: Map<string, string> | Record<string, string>) => {
    const get = (key: string) => (map instanceof Map ? map.get(key) : map[key])
    return (scope ? get(scope) : undefined) ?? get('*')
  }
  const manifest = await readJson(join(root, dir, 'package.json'))
  const publishConfig = manifest['publishConfig']
  const published = isRecord(publishConfig) ? publishConfig['registry'] : undefined
  const npmrc = await Promise.all(
    [...new Set([join(root, dir, '.npmrc'), join(root, '.npmrc')])].map((path) =>
      readFile(path, 'utf8').then(npmrcRegistries, () => new Map<string, string>()),
    ),
  )
  const candidates = [
    pick(context.options.registries),
    typeof published === 'string' ? published : undefined,
    ...npmrc.map(pick),
    context.forge?.npmRegistry?.(context.repo.path),
    DEFAULT_REGISTRY,
  ]
  return [
    ...new Set(candidates.filter((url): url is string => typeof url === 'string').map(withSlash)),
  ]
}

/** Registry clients that send the forge token to the forge's own host, created once per run. */
function registryClients(context: Context) {
  const clients = new Map<string, LibraryRegistry>()
  const forgeHost = (() => {
    try {
      return context.forgeAccess ? new URL(context.forgeAccess.url).host : undefined
    } catch {
      return undefined
    }
  })()
  const token = context.forgeAccess?.token
  return (url: string) => {
    let client = clients.get(url)
    if (!client) {
      client = npmRegistry({
        url: url.replace(/\/$/, ''),
        maxTarballBytes: 200_000_000,
        archive: {
          keep: () => true,
          textOnly: false,
          maxFileBytes: 50_000_000,
          maxTotalBytes: 500_000_000,
        },
        headers: (target) =>
          token && forgeHost && new URL(target).host === forgeHost
            ? { authorization: `Bearer ${token}` }
            : undefined,
      })
      clients.set(url, client)
    }
    return client
  }
}

const matches = (globs: string[], name: string) =>
  globs.some((glob) => new Bun.Glob(glob).match(name))

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = []
  const queue = items.map((item, index) => ({ item, index }))
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift())
      // oxlint-disable-next-line no-await-in-loop -- each lane works through the queue in order
      results[entry.index] = await work(entry.item)
  })
  await Promise.all(lanes)
  return results
}

/** `name@version` of package targets earlier records measured fine. */
async function measuredBefore(context: Context): Promise<Set<string>> {
  const records =
    (await context.history?.analyses.list({
      repo: context.repo,
      kind: bundleAnalysis.kind,
      limit: 500,
    })) ?? []
  const keys = new Set<string>()
  for (const record of records) {
    if (!isBundleAnalysisData(record.data)) continue
    for (const target of bundleTargets(record.data))
      if (target.source === 'package' && target.status === 'ok') keys.add(targetKey(target))
  }
  return keys
}

async function measurePackages(context: Context, root: string): Promise<BundleTarget[]> {
  const { options, log, cache } = context
  if (options.source === 'build' || options.dist || options.build) return []
  const published = (await findPackages(root)).filter(
    (manifest) =>
      !manifest.private &&
      manifest.version &&
      (!options.packages.length || matches(options.packages, manifest.name)) &&
      !matches(options.excludePackages, manifest.name),
  )
  if (!published.length) return []
  const done = await measuredBefore(context)
  const client = registryClients(context)

  const jobs = (
    await pool(published, CONCURRENCY, async (manifest) => {
      const candidates = await registryCandidates(context, root, manifest.dir, manifest.name)
      for (const url of candidates) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- the first registry that knows it wins
          const library = await client(url).library({ ecosystem: 'npm', name: manifest.name })
          if (!library?.versions.some((item) => item.version === manifest.version)) continue
          const current = library.versions.find((item) => item.version === manifest.version)
          const older = library.versions
            .filter(
              (item) =>
                item.version !== manifest.version &&
                item.publishedAt &&
                current?.publishedAt &&
                item.publishedAt < current.publishedAt &&
                (options.includePrereleases || !item.version.includes('-')),
            )
            .toSorted((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
            .slice(0, options.history)
          return [current, ...older].flatMap((item) =>
            item && !done.has(`${manifest.name}@${item.version}`)
              ? [{ url, name: manifest.name, version: item.version, at: item.publishedAt }]
              : [],
          )
        } catch (error) {
          log?.(
            `bundle: ${manifest.name} in ${url}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      log?.(`bundle: ${manifest.name}@${manifest.version} is in none of ${candidates.join(', ')}`)
      return []
    })
  ).flat()
  log?.(`bundle: ${jobs.length} package version(s) to measure, ${done.size} measured before`)

  return pool(jobs, CONCURRENCY, async (job): Promise<BundleTarget> => {
    const cacheKey = `bundle-package:v1:${job.url}${job.name}@${job.version}`
    const cached = await cache?.get(cacheKey)
    const reused = cached
      ? bundleTargetSchema.safeParse(JSON.parse(new TextDecoder().decode(cached.data)))
      : undefined
    if (reused?.success) return reused.data
    const base = {
      name: job.name,
      source: 'package' as const,
      version: job.version,
      ...(job.at ? { at: job.at } : {}),
    }
    let target: BundleTarget
    try {
      const files = await client(job.url).archive({ ecosystem: 'npm', name: job.name }, job.version)
      target = files
        ? await analyzePackage({
            name: job.name,
            version: job.version,
            files,
            ...(job.at ? { publishedAt: job.at } : {}),
          })
        : { ...base, status: 'failed', error: 'the registry has no archive for this version' }
    } catch (error) {
      target = {
        ...base,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (target.status === 'ok')
      await cache?.set(cacheKey, new TextEncoder().encode(JSON.stringify(target)), {
        contentType: 'application/json',
      })
    else log?.(`bundle: ${job.name}@${job.version} failed: ${target.error}`)
    return target
  })
}

/**
 * Measures what a repository ships: its app builds (one target per build, each with its
 * entrypoints) and the versions of the packages it publishes, downloaded from their registry.
 */
export const bundleAnalyzer = defineAnalyzer({
  kind: 'bundle',
  analysis: bundleAnalysis,
  scope: 'repo',
  needs: { checkout: true, forge: true, forgeAccess: true, history: true },
  options: bundleOptions,
  appliesTo: anyOf(
    fileContains(
      ['package.json'],
      /"(?:workspaces|publishConfig|exports|vite|webpack|rollup|@rspack\/core|@rsbuild\/core)"\s*:/,
    ),
    hasFile('pnpm-workspace.yaml'),
  ),
  flags: [
    {
      flag: 'source',
      option: 'source',
      description: 'auto (default), build or packages',
    },
    { flag: 'dist', option: 'dist', description: 'build output directory of one app target' },
    {
      flag: 'build',
      option: 'build',
      description: 'shell command that builds one app target, e.g. "bun run build"',
    },
    {
      flag: 'history',
      option: 'history',
      description: 'earlier published versions per package to measure as well (default 0)',
    },
  ],
  async run(context) {
    if (!context.dir) throw new Error('this analyzer needs a checkout')
    const root = context.dir
    const builds = await measureBuilds(context, root, await buildTargets(root, context.options))
    const packages = await measurePackages(context, root)
    const data: BundleRecordData = { targets: [...builds, ...packages] }
    return { data, ...(context.ref ? { ref: context.ref } : {}) }
  },
})
