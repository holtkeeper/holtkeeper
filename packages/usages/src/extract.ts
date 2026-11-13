import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { analyzeDependencies, directDependencies } from '@holtkeeper/depgraph'
import { jsLockfileSource, jsWorkspaceSource, readJsWorkspaces } from '@holtkeeper/depgraph-js'
import type { JsWorkspace } from '@holtkeeper/depgraph-js'
import type { CommandRunner } from '@holtkeeper/exec'

import { extractGoUsages } from './go.ts'
import { type Positions, type RawSite, byUses, group, lineIndex, usageLimits } from './group.ts'
import type { TypeResolution, UsagesData, UsedPackage } from './model.ts'
import { type Candidate, scanFile } from './scan.ts'
import { resolveTypes } from './types.ts'

export { snippetOf, usageLimits } from './group.ts'

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
  /**
   * Ask the TypeScript checker about names the imports do not explain, and the Go type checker
   * (through `runner`) about members reached through values. Default true.
   */
  types?: boolean
  /** Runs `go` for the Go type checker; without it Go stays syntactic. */
  runner?: CommandRunner
  /** Time limit of the Go type checker; default 5 minutes. */
  goTypesTimeoutMs?: number
  signal?: AbortSignal
  log?: (line: string) => void
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

/**
 * Reads what a checkout uses of the packages it imports, per ecosystem, and concatenates the
 * results: JavaScript and TypeScript when a root `package.json` exists, Go when a `go.mod` or
 * `go.work` does (see `extractGoUsages`). For JavaScript, every source file outside
 * `node_modules` and build output is scanned for imports and the names that refer to them, then,
 * when `types` is on and a `tsconfig.json` and installed dependencies exist, the TypeScript
 * checker resolves what the imports do not explain; versions come from the lockfile. Sites are
 * grouped by package and export with counts of the members and JSX props used; each export keeps
 * a few sites with a snippet. Nothing is installed or built here, apart from the Go helper the
 * Go type checker compiles and the modules `go list` downloads. `types` describes the pass that
 * ran (`combineTypes`): the JavaScript checker, the Go checker (reasons start with `go:`), or both.
 */
export async function extractUsages(options: ExtractUsagesOptions): Promise<UsagesData> {
  const { dir, signal, log } = options
  let workspaces: JsWorkspace[] | undefined
  try {
    const found = await readJsWorkspaces(dir)
    workspaces = [found.root, ...found.packages]
  } catch {
    workspaces = undefined
  }
  const js = workspaces ? await extractJsUsages(options, workspaces) : undefined
  const go = await extractGoUsages({
    dir,
    ...(options.packages ? { packages: options.packages } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.types === false ? { types: false } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.goTypesTimeoutMs ? { typesTimeoutMs: options.goTypesTimeoutMs } : {}),
    ...(signal ? { signal } : {}),
    ...(log ? { log } : {}),
  })
  const problems = [...(js?.problems ?? []), ...(go?.problems ?? [])]
  const types = combineTypes(js?.types, go?.types)
  return {
    packages: [...(js?.packages ?? []), ...(go?.packages ?? [])].toSorted(byUses),
    files: (js?.files ?? 0) + (go?.files ?? 0),
    types,
    ...(problems.length ? { problems: problems.slice(0, 50) } : {}),
  }
}

/**
 * One `TypeResolution` for a checkout with JavaScript, Go or both: either pass alone as it is;
 * with both, a skipped pass gives way to the other, and two passes that ran merge (`used` when
 * either was, reasons joined, projects listed together, sites summed).
 */
export function combineTypes(js?: TypeResolution, go?: TypeResolution): TypeResolution {
  if (!go) return js ?? { status: 'skipped', reason: 'no package.json, go.mod or go.work' }
  if (!js) return go
  if (go.status === 'skipped') return js
  if (js.status === 'skipped') return go
  const reasons = [js.reason, go.reason].filter(Boolean)
  const projects = [...(js.projects ?? []), ...(go.projects ?? [])]
  const sites = (js.sites ?? 0) + (go.sites ?? 0)
  return {
    status: js.status === 'used' || go.status === 'used' ? 'used' : 'failed',
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    ...(projects.length ? { projects } : {}),
    ...(js.sites !== undefined || go.sites !== undefined ? { sites } : {}),
  }
}

async function extractJsUsages(
  options: ExtractUsagesOptions,
  workspaces: JsWorkspace[],
): Promise<{
  packages: UsedPackage[]
  files: number
  types: TypeResolution
  problems: string[]
}> {
  const { dir, signal, log } = options
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
  const positions = new Map<string, Positions>()
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
  return { packages, files: files.length, types, problems }
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
