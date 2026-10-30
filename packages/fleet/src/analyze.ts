import type { GitForge, RepoRef } from '@holtkeeper/forge'

import { type Lockfile, lockfileNames, parseLockfile } from './lockfiles.ts'
import {
  globToRegExp,
  isGlob,
  joinPath,
  normalizeDir,
  parseGoMod,
  parseGoWork,
  parsePackageJson,
  parsePnpmWorkspace,
  workspaceDirs,
} from './manifests.ts'
import type { VersionRegistry } from './registry.ts'
import { minimumOfRange } from './semver.ts'
import { compareWithTemplate, templateChange, type TemplateSpec } from './templates.ts'
import type {
  Ecosystem,
  FleetData,
  FleetNote,
  FleetRepo,
  LibraryUsage,
  TemplateResult,
  TrackedLibrary,
} from './types.ts'

/** The forge calls the analysis makes; it never clones. */
export type FleetForge = Pick<GitForge, 'readFile' | 'getRepository' | 'listFiles'>

export interface AnalyzeFleetOptions {
  /** Group name, stored as the record's subject. */
  group: string
  /** Forge id of the group's repositories, for change targets and `forge:path` template sources. */
  forgeId: string
  repos: RepoRef[]
  forge: FleetForge
  registry: VersionRegistry
  /** Library names or globs always tracked, e.g. `react`, `@company/*`, `github.com/company/**`. */
  libraries?: string[]
  /** Also track every library used directly by at least this many repositories; `0` disables. Default 3. */
  minRepos?: number
  /** Workspace manifests read per repository besides the root. Default 20. */
  maxWorkspaces?: number
  /** Cap for automatically tracked libraries, most used first. Default 100. */
  maxLibraries?: number
  templates?: TemplateSpec[]
  /** Repositories read in parallel. Default 4. */
  concurrency?: number
  log?: (line: string) => void
}

interface Found {
  ecosystem: Ecosystem
  name: string
  usage: LibraryUsage
}

interface RepoScan {
  repo: FleetRepo
  found: Found[]
  notes: FleetNote[]
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Directories matching glob `patterns`, listed through `forge.listFiles` from each pattern's
 * literal prefix; `undefined` when the forge cannot list or there is nothing to expand.
 */
async function listedDirs(
  forge: FleetForge,
  path: string,
  patterns: string[],
  scan: RepoScan,
): Promise<string[] | undefined> {
  const globs = patterns.map(normalizeDir).filter(isGlob)
  if (!forge.listFiles || globs.length === 0) return undefined
  const list = forge.listFiles.bind(forge)
  try {
    const listings = await Promise.all(
      globs.map((glob) => {
        const segments = glob.split('/')
        const first = segments.findIndex(isGlob)
        const base = segments.slice(0, first).join('/')
        const recursive = glob.includes('**') || segments.length - first > 1
        return list(path, { ...(base ? { path: base } : {}), recursive, limit: 5000 })
      }),
    )
    return listings
      .flat()
      .filter((entry) => entry.type === 'dir' && !entry.path.split('/').includes('node_modules'))
      .map((entry) => entry.path)
  } catch (error) {
    scan.notes.push({
      repo: path,
      message: `workspace directories could not be listed: ${message(error)}`,
    })
    return undefined
  }
}

async function readLockfile(forge: FleetForge, path: string): Promise<Lockfile | undefined> {
  for (const file of lockfileNames) {
    const text = await forge.readFile(path, file)
    if (text !== undefined) return parseLockfile(file, text)
  }
  return undefined
}

async function scanNpm(forge: FleetForge, path: string, maxWorkspaces: number, scan: RepoScan) {
  const rootText = await forge.readFile(path, 'package.json')
  if (rootText === undefined) return
  const root = parsePackageJson(rootText)
  scan.repo.manifests.push('package.json')
  const pnpmText = await forge.readFile(path, 'pnpm-workspace.yaml')
  const patterns = [...root.workspaces, ...(pnpmText ? parsePnpmWorkspace(pnpmText) : [])]

  let lockfile: Lockfile | undefined
  try {
    lockfile = await readLockfile(forge, path)
    if (lockfile) scan.repo.manifests.push(lockfile.file)
  } catch (error) {
    scan.notes.push({ repo: path, message: `lockfile could not be read: ${message(error)}` })
  }
  const listed = await listedDirs(forge, path, patterns, scan)
  if (!listed && !lockfile && patterns.some(isGlob))
    scan.notes.push({
      repo: path,
      message:
        'workspace globs were not expanded: the forge cannot list files and no lockfile lists the workspaces',
    })

  const dirs = workspaceDirs(patterns, listed ?? lockfile?.importers ?? [], maxWorkspaces)
  const manifests = [{ dir: '.', manifest: root }]
  const texts = await Promise.all(
    dirs.map((dir) =>
      forge.readFile(path, joinPath(dir, 'package.json')).catch((error: unknown) => error),
    ),
  )
  dirs.forEach((dir, index) => {
    const file = joinPath(dir, 'package.json')
    const text = texts[index]
    if (text === undefined) return
    try {
      if (typeof text !== 'string') throw text
      manifests.push({ dir, manifest: parsePackageJson(text) })
      scan.repo.manifests.push(file)
    } catch (error) {
      scan.notes.push({ repo: path, message: `${file} could not be read: ${message(error)}` })
    }
  })
  const own = new Set(manifests.map(({ manifest }) => manifest.name).filter(Boolean))
  for (const { dir, manifest } of manifests) {
    for (const dependency of manifest.dependencies) {
      if (own.has(dependency.name) || dependency.declared.startsWith('workspace:')) continue
      const resolved = lockfile?.resolve(dir, dependency.name)
      const version = resolved ?? minimumOfRange(dependency.declared)
      scan.found.push({
        ecosystem: 'npm',
        name: dependency.name,
        usage: {
          repo: path,
          manifest: joinPath(dir, 'package.json'),
          declared: dependency.declared,
          ...(resolved ? { resolved } : {}),
          ...(version ? { version } : {}),
          kind: dependency.kind,
        },
      })
    }
  }
}

async function scanGo(forge: FleetForge, path: string, maxWorkspaces: number, scan: RepoScan) {
  const work = await forge.readFile(path, 'go.work')
  const patterns = work ? parseGoWork(work) : []
  const listed = await listedDirs(forge, path, patterns, scan)
  const dirs = ['.', ...workspaceDirs(patterns, listed ?? [], maxWorkspaces)]
  const modules: {
    file: string
    requires: ReturnType<typeof parseGoMod>['requires']
    module?: string
  }[] = []
  const files = dirs.map((dir) => joinPath(dir, 'go.mod'))
  const texts = await Promise.all(files.map((file) => forge.readFile(path, file)))
  files.forEach((file, index) => {
    const text = texts[index]
    if (text === undefined) return
    modules.push({ file, ...parseGoMod(text) })
    scan.repo.manifests.push(file)
  })
  const own = new Set(modules.map((module) => module.module).filter(Boolean))
  for (const module of modules) {
    for (const requirement of module.requires) {
      if (own.has(requirement.name)) continue
      scan.found.push({
        ecosystem: 'Go',
        name: requirement.name,
        usage: {
          repo: path,
          manifest: module.file,
          declared: requirement.declared,
          version: requirement.declared.replace(/\+incompatible$/, ''),
          kind: requirement.kind,
        },
      })
    }
  }
}

async function scanRepo(forge: FleetForge, ref: RepoRef, maxWorkspaces: number): Promise<RepoScan> {
  const scan: RepoScan = { repo: { path: ref.path, manifests: [] }, found: [], notes: [] }
  try {
    const info = await forge.getRepository(ref.path)
    scan.repo.webUrl = info.webUrl
    if (info.archived) {
      scan.repo.archived = true
      return scan
    }
  } catch (error) {
    scan.repo.error = message(error)
    return scan
  }
  for (const [ecosystem, run] of [
    ['npm', scanNpm],
    ['Go', scanGo],
  ] as const) {
    try {
      await run(forge, ref.path, maxWorkspaces, scan)
    } catch (error) {
      scan.notes.push({
        repo: ref.path,
        message: `${ecosystem} manifests could not be read: ${message(error)}`,
      })
    }
  }
  return scan
}

const libraryKey = (ecosystem: Ecosystem, name: string) => `${ecosystem}:${name}`

/**
 * Which libraries to track: those matching `patterns`, plus those used directly (not `indirect`)
 * by at least `minRepos` repositories, at most `maxLibraries` of the latter, most used first.
 */
export function selectLibraries(
  found: Found[],
  patterns: string[],
  minRepos: number,
  maxLibraries: number,
): { ecosystem: Ecosystem; name: string; reason: 'option' | 'auto' }[] {
  const matchers = patterns.map((pattern) => (isGlob(pattern) ? globToRegExp(pattern) : pattern))
  const listed = (name: string) =>
    matchers.some((matcher) =>
      typeof matcher === 'string' ? matcher === name : matcher.test(name),
    )
  const repos = new Map<string, { ecosystem: Ecosystem; name: string; repos: Set<string> }>()
  for (const { ecosystem, name, usage } of found) {
    const key = libraryKey(ecosystem, name)
    const entry = repos.get(key) ?? { ecosystem, name, repos: new Set() }
    if (usage.kind !== 'indirect') entry.repos.add(usage.repo)
    repos.set(key, entry)
  }
  const all = [...repos.values()]
  const option = all.filter((entry) => listed(entry.name))
  const auto =
    minRepos > 0
      ? all
          .filter((entry) => !listed(entry.name) && entry.repos.size >= minRepos)
          .toSorted((a, b) => b.repos.size - a.repos.size || a.name.localeCompare(b.name))
          .slice(0, maxLibraries)
      : []
  return [
    ...option.map(({ ecosystem, name }) => ({ ecosystem, name, reason: 'option' as const })),
    ...auto.map(({ ecosystem, name }) => ({ ecosystem, name, reason: 'auto' as const })),
  ].toSorted((a, b) => a.name.localeCompare(b.name) || a.ecosystem.localeCompare(b.ecosystem))
}

/** Splits `forge:group/repo` into its parts; a value without a forge prefix uses `fallback`. */
export function parseRepoSource(value: string, fallback: string): RepoRef {
  const index = value.indexOf(':')
  return index === -1
    ? { forge: fallback, path: value }
    : { forge: value.slice(0, index), path: value.slice(index + 1) }
}

async function templateContent(
  forge: FleetForge,
  forgeId: string,
  spec: TemplateSpec,
): Promise<{ content?: string; error?: string }> {
  const source = spec.source
  if (!source) return {}
  if ('content' in source) return { content: source.content }
  const repo = parseRepoSource(source.repo, forgeId)
  if (repo.forge !== forgeId) return { error: `template source ${source.repo} is on another forge` }
  const file = source.file ?? spec.path
  try {
    const content = await forge.readFile(repo.path, file, source.ref)
    return content === undefined
      ? { error: `template ${repo.path}/${file} does not exist` }
      : { content }
  } catch (error) {
    return { error: `template ${repo.path}/${file} could not be read: ${message(error)}` }
  }
}

/**
 * Reads manifests and config files of every repository through the forge API, looks up latest
 * versions and compares config files with their templates. Unreadable repositories and files end
 * up in `notes` or the repository's `error`; the rest of the fleet is still analyzed.
 */
export async function analyzeFleet(options: AnalyzeFleetOptions): Promise<FleetData> {
  const {
    group,
    forgeId,
    repos,
    forge,
    registry,
    libraries = [],
    minRepos = 3,
    maxWorkspaces = 20,
    maxLibraries = 100,
    templates = [],
    concurrency = 4,
    log,
  } = options

  const scans = await mapLimit(repos, concurrency, (ref) => {
    log?.(`reading ${ref.path}`)
    return scanRepo(forge, ref, maxWorkspaces)
  })
  const found = scans.flatMap((scan) => scan.found)
  const notes = scans.flatMap((scan) => scan.notes)

  const selected = selectLibraries(found, libraries, minRepos, maxLibraries)
  const byKey = Map.groupBy(found, (entry) => libraryKey(entry.ecosystem, entry.name))
  const tracked: TrackedLibrary[] = await mapLimit(
    selected,
    8,
    async ({ ecosystem, name, reason }) => {
      const latest = await registry.latest(ecosystem, name)
      return {
        ecosystem,
        name,
        ...(latest ? { latest } : {}),
        reason,
        usages: (byKey.get(libraryKey(ecosystem, name)) ?? []).map((entry) => entry.usage),
      }
    },
  )

  const readable = scans
    .filter((scan) => !scan.repo.error && !scan.repo.archived)
    .map((scan) => scan.repo.path)
  const contents = await Promise.all(templates.map((spec) => templateContent(forge, forgeId, spec)))
  const pairs = templates.flatMap((spec, index) =>
    readable.map((path) => ({ spec, path, template: contents[index] ?? {} })),
  )
  const results = await mapLimit(
    pairs,
    concurrency,
    async ({ spec, path, template }): Promise<TemplateResult> => {
      const base = { repo: path, file: spec.path, mode: spec.mode }
      if (template.error) return { ...base, status: 'error', problems: [template.error] }
      let actual: string | undefined
      try {
        actual = await forge.readFile(path, spec.path)
      } catch (error) {
        return { ...base, status: 'error', problems: [`file could not be read: ${message(error)}`] }
      }
      const comparison = compareWithTemplate(spec, template.content, actual)
      const change = templateChange({ forge: forgeId, path }, spec, comparison)
      return {
        ...base,
        status: comparison.status,
        problems: comparison.problems,
        ...(change ? { change } : {}),
      }
    },
  )

  return {
    group,
    repos: scans.map((scan) => scan.repo),
    libraries: tracked,
    templates: results,
    notes,
  }
}
