import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { analyzeDependencies, compareVersions, directDependencies } from '@holtkeeper/depgraph'
import { jsLockfileSource, jsWorkspaceSource, readJsWorkspaces } from '@holtkeeper/depgraph-js'
import type { JsWorkspace } from '@holtkeeper/depgraph-js'

import type {
  NameCount,
  TypeResolution,
  UsageKind,
  UsageSite,
  UsagesData,
  UsedExport,
  UsedPackage,
} from './model.ts'
import { type Candidate, scanFile } from './scan.ts'
import { resolveTypes } from './types.ts'

/** Caps that keep one analysis record small enough to store and send. */
export const usageLimits = {
  files: 20_000,
  /** Sites kept with a snippet per export; counts still cover every site. */
  sitesPerExport: 20,
  /** Once a package keeps this many sites, its remaining exports keep `sitesAfterBudget` each. */
  sitesPerPackage: 400,
  sitesAfterBudget: 3,
  /** Members and props listed per export. */
  names: 100,
  snippetLines: 2,
  lineLength: 200,
}

const sourcePattern = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'

const ignoredFolders = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'vendor',
])

/** Options of `extractUsages`. */
export interface ExtractUsagesOptions {
  dir: string
  /** Glob patterns of package names to keep, e.g. `@acme/*`; every imported package when empty. */
  packages?: readonly string[]
  /** Glob patterns of files to skip, relative to the checkout, e.g. `**\/*.test.ts`. */
  exclude?: readonly string[]
  /** Ask the TypeScript checker about names the imports do not explain. Default true. */
  types?: boolean
  signal?: AbortSignal
  log?: (line: string) => void
}

interface RawSite {
  file: string
  offset: number
  package: string
  subpath: string
  export: string
  kind: UsageKind
  member?: string
  props?: string[]
  spread?: boolean
  typed?: boolean
}

async function listFiles(dir: string, exclude: readonly string[]) {
  const skip = exclude.map((pattern) => new Bun.Glob(pattern))
  const files: string[] = []
  for await (const file of new Bun.Glob(sourcePattern).scan({ cwd: dir, onlyFiles: true })) {
    const path = file.replaceAll('\\', '/')
    if (path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')) continue
    if (path.split('/').some((part) => ignoredFolders.has(part))) continue
    if (skip.some((glob) => glob.match(path))) continue
    files.push(path)
    if (files.length >= usageLimits.files) break
  }
  return files.toSorted()
}

const ownerOf = (file: string, workspaces: readonly JsWorkspace[]) =>
  workspaces
    .filter((workspace) => workspace.path === '.' || file.startsWith(`${workspace.path}/`))
    .toSorted((a, b) => b.path.length - a.path.length)[0]

function lineIndex(text: string) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
  }
}

/** Lines around `line` (1-based) with their common indentation removed. */
export function snippetOf(
  lines: readonly string[],
  line: number,
  around = usageLimits.snippetLines,
) {
  const first = Math.max(1, line - around)
  const last = Math.min(lines.length, line + around)
  const picked = lines.slice(first - 1, last).map((text) => {
    const trimmed = text.replace(/\s+$/, '')
    return trimmed.length > usageLimits.lineLength
      ? `${trimmed.slice(0, usageLimits.lineLength)}…`
      : trimmed
  })
  const indent = Math.min(
    ...picked.filter((text) => text.trim()).map((text) => /^[ \t]*/.exec(text)?.[0].length ?? 0),
  )
  const strip = Number.isFinite(indent) ? indent : 0
  return { snippet: picked.map((text) => text.slice(strip)).join('\n'), snippetLine: first }
}

const ranked = (counts: Map<string, number>): NameCount[] =>
  [...counts]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, usageLimits.names)

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

/**
 * Reads what a JavaScript or TypeScript checkout uses of the packages it imports: every source
 * file outside `node_modules` and build output is scanned for imports and the names that refer to
 * them, then, when `types` is on and a `tsconfig.json` and installed dependencies exist, the
 * TypeScript checker resolves what the imports do not explain. Sites are grouped by package and
 * export with counts of the members and JSX props used; each export keeps a few sites with a
 * snippet. Versions come from the lockfile. Nothing is installed or built here.
 */
export async function extractUsages(options: ExtractUsagesOptions): Promise<UsagesData> {
  const { dir, signal, log } = options
  let workspaces: JsWorkspace[]
  try {
    const found = await readJsWorkspaces(dir)
    workspaces = [found.root, ...found.packages]
  } catch {
    return { packages: [], files: 0, types: { status: 'skipped', reason: 'no package.json' } }
  }

  const declared = new Map<string, Map<string, string>>()
  for (const workspace of workspaces)
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const value = workspace.manifest[field]
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      for (const [name, range] of Object.entries(value))
        if (typeof range === 'string')
          (declared.get(name) ?? declared.set(name, new Map()).get(name))?.set(
            workspace.name,
            range,
          )
    }
  const local = new Set(workspaces.filter((workspace) => workspace.path !== '.').map((w) => w.name))
  const wanted = (options.packages ?? []).map((pattern) => new Bun.Glob(pattern))
  const known = (name: string) =>
    (declared.has(name) || local.has(name)) &&
    (!wanted.length || wanted.some((glob) => glob.match(name)))

  const files = await listFiles(dir, options.exclude ?? [])
  log?.(`usages: scanning ${files.length} file(s) in ${workspaces.length} workspace(s)`)
  const raw: RawSite[] = []
  const problems: string[] = []
  const pending = new Map<string, { workspace: string; candidates: Candidate[] }>()
  const positions = new Map<string, ReturnType<typeof lineIndex>>()
  const owners = new Map<string, string>()

  for (const file of files) {
    signal?.throwIfAborted()
    let code: string
    try {
      // oxlint-disable-next-line no-await-in-loop -- files are read one at a time to bound memory
      code = await readFile(join(dir, file), 'utf8')
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const workspace = ownerOf(file, workspaces)?.name ?? 'root'
    owners.set(file, workspace)
    const scan = scanFile(file, code, (name) => known(name) && name !== workspace)
    if (scan.problem) problems.push(`${file}: ${scan.problem.split('\n')[0]}`)
    if (!scan.sites.length && !scan.candidates.length) continue
    positions.set(file, lineIndex(code))
    for (const site of scan.sites) raw.push({ file, ...site })
    if (scan.candidates.length) pending.set(file, { workspace, candidates: scan.candidates })
  }

  let types: TypeResolution = { status: 'skipped', reason: 'turned off' }
  if (options.types ?? true) {
    const outcome = await resolveTypes({
      dir,
      workspaces,
      files: pending,
      known,
      ...(signal ? { signal } : {}),
    })
    types = {
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.projects.length ? { projects: outcome.projects } : {}),
      ...(outcome.status === 'used' ? { sites: outcome.sites.length } : {}),
    }
    log?.(
      `usages: type checker ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}, ${outcome.sites.length} site(s)`,
    )
    for (const site of outcome.sites) raw.push({ ...site, subpath: '.', typed: true })
  }

  const versions = await lockedVersions(dir)
  const localVersions = new Map(
    workspaces.flatMap((workspace) =>
      workspace.path !== '.' && workspace.version
        ? [[workspace.name, workspace.version] as const]
        : [],
    ),
  )
  const packages = await group({
    dir,
    raw,
    positions,
    owners,
    declared,
    versions,
    local,
    localVersions,
  })
  return {
    packages,
    files: files.length,
    types,
    ...(problems.length ? { problems: problems.slice(0, 50) } : {}),
  }
}

/** Version the lockfile resolves per package and workspace. */
async function lockedVersions(dir: string) {
  const result = new Map<string, Map<string, string>>()
  try {
    const data = await analyzeDependencies({
      dir,
      sources: [jsWorkspaceSource(), jsLockfileSource()],
    })
    for (const dependency of directDependencies(data))
      (
        result.get(dependency.name) ?? result.set(dependency.name, new Map()).get(dependency.name)
      )?.set(dependency.workspace, dependency.version)
  } catch {
    // A missing or unreadable lockfile leaves versions unknown; usages are still worth reporting.
  }
  return result
}

async function group(input: {
  dir: string
  raw: RawSite[]
  positions: Map<string, ReturnType<typeof lineIndex>>
  owners: Map<string, string>
  declared: Map<string, Map<string, string>>
  versions: Map<string, Map<string, string>>
  local: Set<string>
  localVersions: Map<string, string>
}): Promise<UsedPackage[]> {
  const byPackage = new Map<string, Map<string, RawSite[]>>()
  for (const site of input.raw) {
    const exports =
      byPackage.get(site.package) ?? byPackage.set(site.package, new Map()).get(site.package)
    const key = `${site.subpath}\0${site.export}`
    const list = exports?.get(key)
    if (list) list.push(site)
    else exports?.set(key, [site])
  }

  const lines = new Map<string, string[]>()
  const linesOf = async (file: string) => {
    const cached = lines.get(file)
    if (cached) return cached
    const text = await readFile(join(input.dir, file), 'utf8').catch(() => '')
    const split = text.split('\n')
    lines.set(file, split)
    return split
  }

  const packages: UsedPackage[] = []
  for (const [name, exports] of byPackage) {
    const workspaces = new Set<string>()
    const packageFiles = new Set<string>()
    const used: UsedExport[] = []
    let count = 0
    let keptInPackage = 0
    const byCount = [...exports.values()].toSorted((a, b) => b.length - a.length)
    for (const sites of byCount) {
      const ordered = sites.toSorted((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset)
      const first = ordered[0]
      if (!first) continue
      const kinds: Partial<Record<UsageKind, number>> = {}
      const members = new Map<string, number>()
      const props = new Map<string, number>()
      const files = new Set<string>()
      let spread = 0
      for (const site of ordered) {
        kinds[site.kind] = (kinds[site.kind] ?? 0) + 1
        if (site.member) bump(members, site.member)
        for (const prop of site.props ?? []) bump(props, prop)
        if (site.spread) spread += 1
        files.add(site.file)
        packageFiles.add(site.file)
        workspaces.add(input.owners.get(site.file) ?? 'root')
      }
      const kept: UsageSite[] = []
      const budget =
        keptInPackage < usageLimits.sitesPerPackage
          ? usageLimits.sitesPerExport
          : usageLimits.sitesAfterBudget
      for (const site of ordered.slice(0, budget)) {
        const at = input.positions.get(site.file)?.(site.offset) ?? { line: 1, column: 1 }
        // oxlint-disable-next-line no-await-in-loop -- files are cached after the first read
        const snippet = snippetOf(await linesOf(site.file), at.line)
        kept.push({
          file: site.file,
          line: at.line,
          column: at.column,
          kind: site.kind,
          ...(site.member ? { member: site.member } : {}),
          ...(site.props?.length ? { props: site.props } : {}),
          ...(site.spread ? { spread: true } : {}),
          ...(site.typed ? { typed: true } : {}),
          ...snippet,
        })
      }
      count += ordered.length
      keptInPackage += kept.length
      used.push({
        name: first.export,
        subpath: first.subpath,
        count: ordered.length,
        files: files.size,
        kinds,
        members: ranked(members),
        props: ranked(props),
        spread,
        sites: kept,
        ...(ordered.length > kept.length ? { truncated: ordered.length - kept.length } : {}),
      })
    }
    const resolved = new Set<string>()
    const ranges = new Set<string>()
    for (const workspace of workspaces) {
      const version = input.versions.get(name)?.get(workspace)
      if (version) resolved.add(version)
      const range = input.declared.get(name)?.get(workspace)
      if (range) ranges.add(range)
    }
    if (!resolved.size)
      for (const version of input.versions.get(name)?.values() ?? []) resolved.add(version)
    const own = input.localVersions.get(name)
    if (!resolved.size && own) resolved.add(own)
    if (!ranges.size)
      for (const range of input.declared.get(name)?.values() ?? []) ranges.add(range)
    packages.push({
      name,
      versions: [...resolved].toSorted((a, b) => compareVersions(b, a)),
      ranges: [...ranges].toSorted(),
      workspaces: [...workspaces].toSorted(),
      ...(input.local.has(name) ? { local: true } : {}),
      count,
      files: packageFiles.size,
      exports: used.toSorted(
        (a, b) =>
          b.count - a.count || a.name.localeCompare(b.name) || a.subpath.localeCompare(b.subpath),
      ),
    })
  }
  return packages.toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
