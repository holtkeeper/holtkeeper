import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import {
  type GoImportResolution,
  type GoTypedRun,
  type GoUsageScan,
  type GoWorkspaceModule,
  defaultPackageName,
  discoverGoModules,
  findGoModules,
  goTypedUsages,
  mask,
  readGoModules,
  resolveGoImport,
  scanGoUsages,
} from '@holtkeeper/go-source'

import { type RawSite, group, usageLimits } from './group.ts'
import type { TypeResolution, UsageKind, UsedPackage } from './model.ts'

const skippedSegments = new Set(['vendor', 'testdata', 'node_modules'])

const skippedPath = (path: string) =>
  path
    .split('/')
    .some((part) => skippedSegments.has(part) || part.startsWith('.') || part.startsWith('_'))

/** Go source files the `go` command would consider, relative and sorted; at most `usageLimits.files`. */
async function listGoFiles(dir: string, exclude: readonly string[]) {
  const skip = exclude.map((pattern) => new Bun.Glob(pattern))
  const files: string[] = []
  for await (const file of new Bun.Glob('**/*.go').scan({ cwd: dir, onlyFiles: true })) {
    const path = file.replaceAll('\\', '/')
    if (skippedPath(path)) continue
    if (skip.some((glob) => glob.match(path))) continue
    files.push(path)
    if (files.length >= usageLimits.files) break
  }
  return files.toSorted()
}

/**
 * Own modules of the checkout: `go.work` members plus every `go.mod` found, by directory, and the
 * directories of the `go.work` members.
 */
async function repoModules(dir: string) {
  const discovered = await discoverGoModules(dir)
  if (!discovered.workspace) return { modules: discovered.modules, members: [] }
  const known = new Set(discovered.modules.map((module) => module.dir))
  const nested = await readGoModules(
    dir,
    (await findGoModules(dir)).filter((moduleDir) => !known.has(moduleDir)),
  )
  return { modules: [...discovered.modules, ...nested], members: [...known] }
}

/** One `go list` per module; the `go.work` members together, in workspace mode. */
function typedRuns(modules: readonly GoWorkspaceModule[], members: readonly string[]) {
  const runs: GoTypedRun[] = []
  if (members.length)
    runs.push({
      dir: '.',
      gowork: 'go.work',
      patterns: members.map((member) => (member === '.' ? './...' : `./${member}/...`)),
    })
  const inWorkspace = new Set(members)
  for (const module of modules) if (!inWorkspace.has(module.dir)) runs.push({ dir: module.dir })
  return runs
}

const within = (file: string, moduleDir: string) =>
  moduleDir === '.' || file.startsWith(`${moduleDir}/`)

const ownerOf = (file: string, modules: readonly GoWorkspaceModule[]) =>
  modules
    .filter((module) => within(file, module.dir))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0]

const record = (
  map: Map<string, Map<string, string>>,
  module: string,
  owner: string,
  version: string,
) => (map.get(module) ?? map.set(module, new Map()).get(module))?.set(owner, version)

const packageClause = /^[ \t]*package[ \t]+([\p{L}_][\p{L}\p{N}_]*)/mu

/** What `extractGoUsages` found; absent when the checkout has no Go module. */
export interface GoUsages {
  packages: UsedPackage[]
  files: number
  modules: number
  problems: string[]
  /** The Go type checker pass; `projects` are the module paths it covered, reasons start with `go:`. */
  types: TypeResolution
}

/**
 * Reads what the Go modules of a checkout use of the modules they import. The syntactic pass needs
 * neither the `go` command nor the network: every `.go` file (tests included; `vendor`, `testdata`,
 * hidden and `_`-prefixed paths skipped) belongs to the deepest module containing it, its imports
 * and qualified identifiers are scanned with `@holtkeeper/go-source`, and each import path is mapped
 * to a module by the owning `go.mod`. One `UsedPackage` per module, with the package directory as
 * `subpath`; versions come from `require`/`replace`. Standard library imports and imports of the
 * owning module itself are left out; the repository's other modules and locally replaced ones are
 * `local`. Imports no `go.mod` covers are reported through `log` and skipped.
 *
 * With `types` (default true) and a `runner`, the Go type checker (`goTypedUsages`) then adds the
 * fields and methods reached through values as `typed` sites, mapped to modules the same way; a
 * site at a position the syntactic pass already holds is dropped. Without Go, on download or type
 * errors or past `typesTimeoutMs`, the syntactic result stands and `types` says why.
 */
export async function extractGoUsages(options: {
  dir: string
  packages?: readonly string[]
  exclude?: readonly string[]
  /** Run the Go type checker through `runner`. Default true. */
  types?: boolean
  runner?: CommandRunner
  /** Time limit of the type checker over all modules; default 5 minutes. */
  typesTimeoutMs?: number
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<GoUsages | undefined> {
  const { dir, signal, log } = options
  const { modules, members } = await repoModules(dir)
  if (!modules.length) return undefined
  const files = await listGoFiles(dir, options.exclude ?? [])
  log?.(`usages: scanning ${files.length} Go file(s) in ${modules.length} module(s)`)

  const wanted = (options.packages ?? []).map((pattern) => new Bun.Glob(pattern))
  const keep = (name: string) => !wanted.length || wanted.some((glob) => glob.match(name))
  const problems: string[] = []
  const scans = new Map<string, { owner: GoWorkspaceModule; scan: GoUsageScan }>()
  const localNames = new Map<string, string>()
  let outside = 0

  const read = async (file: string) => {
    try {
      return await readFile(join(dir, file), 'utf8')
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  for (const file of files) {
    signal?.throwIfAborted()
    const owner = ownerOf(file, modules)
    if (!owner) {
      outside += 1
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- files are read one at a time to bound memory
    const source = await read(file)
    if (source === undefined) continue
    const name = packageClause.exec(mask(source).code)?.[1]
    if (name && name !== 'main' && !name.endsWith('_test')) {
      const relative = posix.relative(owner.dir === '.' ? '' : owner.dir, posix.dirname(file))
      const path = relative && relative !== '.' ? `${owner.module}/${relative}` : owner.module
      if (!localNames.has(path)) localNames.set(path, name)
    }
    scans.set(file, { owner, scan: scanGoUsages(source) })
  }
  if (outside) log?.(`usages: ${outside} Go file(s) outside every module skipped`)

  const renamed = new Set(
    [...localNames].filter(([path, name]) => defaultPackageName(path) !== name).map(([p]) => p),
  )
  if (renamed.size)
    for (const [file, entry] of scans) {
      if (!entry.scan.imports.some((item) => !item.alias && renamed.has(item.path))) continue
      // oxlint-disable-next-line no-await-in-loop -- only files importing a renamed package
      const source = await read(file)
      if (source !== undefined) entry.scan = scanGoUsages(source, localNames)
    }

  const resolutions = new Map<string, GoImportResolution>()
  const resolve = (importPath: string, owner: GoWorkspaceModule) => {
    const key = `${owner.dir}\0${importPath}`
    const cached = resolutions.get(key)
    if (cached) return cached
    const resolved = resolveGoImport(importPath, owner, modules)
    resolutions.set(key, resolved)
    return resolved
  }

  const raw: RawSite[] = []
  const owners = new Map<string, string>()
  const declared = new Map<string, Map<string, string>>()
  const versions = new Map<string, Map<string, string>>()
  const local = new Set<string>()
  const replacedLocal = new Set<string>()
  const definedLocal = new Set<string>()
  const unresolved = new Set<string>()

  const add = (
    file: string,
    owner: GoWorkspaceModule,
    site: { importPath: string; export: string; kind: UsageKind; member?: string },
    rest: Pick<RawSite, 'offset' | 'at' | 'props' | 'typed'>,
  ) => {
    const where = resolve(site.importPath, owner)
    if (where.kind === 'stdlib') return
    if (where.kind === 'unresolved') {
      unresolved.add(site.importPath)
      return
    }
    if (where.kind === 'local' && where.module === owner.module) return
    if (!keep(where.module)) return
    if (where.kind === 'local') {
      local.add(where.module)
      if (where.replaced) replacedLocal.add(where.module)
      else definedLocal.add(where.module)
    } else {
      if (where.version) record(versions, where.module, owner.module, where.version)
      const required = where.required ?? where.version
      if (required) record(declared, where.module, owner.module, required)
    }
    raw.push({
      file,
      package: where.module,
      subpath: where.subpath,
      export: site.export,
      kind: site.kind,
      ...(site.member ? { member: site.member } : {}),
      ...rest,
    })
  }

  const taken = new Set<string>()
  for (const [file, { owner, scan }] of scans) {
    owners.set(file, owner.module)
    for (const site of scan.sites) {
      taken.add(`${file}:${site.line}:${site.column}`)
      add(file, owner, site, {
        offset: site.offset,
        at: { line: site.line, column: site.column },
        ...(site.props?.length ? { props: site.props } : {}),
      })
    }
  }

  let types: TypeResolution
  if (options.types === false) types = { status: 'skipped', reason: 'go: turned off' }
  else if (!options.runner) types = { status: 'skipped', reason: 'go: no command runner' }
  else {
    const outcome = await goTypedUsages({
      dir,
      runner: options.runner,
      runs: typedRuns(modules, members),
      ...(options.typesTimeoutMs ? { timeoutMs: options.typesTimeoutMs } : {}),
      ...(signal ? { signal } : {}),
      ...(log ? { log } : {}),
    })
    let added = 0
    for (const site of outcome.sites) {
      const entry = scans.get(site.file)
      if (!entry || taken.has(`${site.file}:${site.line}:${site.column}`)) continue
      const before = raw.length
      add(site.file, entry.owner, site, {
        offset: 0,
        at: { line: site.line, column: site.column },
        typed: true,
      })
      added += raw.length - before
    }
    const reason =
      outcome.reason ??
      (outcome.errors.length
        ? `${outcome.errors.length} problem(s), first: ${outcome.errors[0]}`
        : undefined)
    types = {
      status: outcome.status,
      ...(reason ? { reason: `go: ${reason.split('\n')[0]}` } : {}),
      ...(outcome.status === 'skipped' ? {} : { projects: modules.map((module) => module.module) }),
      ...(outcome.status === 'used' ? { sites: added } : {}),
    }
    log?.(
      `usages: Go type checker ${outcome.status}${outcome.reason ? ` (${outcome.reason.split('\n')[0]})` : ''}, ${outcome.packages} package(s), ${added} site(s) added${outcome.truncated ? ', site cap reached' : ''}`,
    )
    for (const error of outcome.errors.slice(0, 5)) log?.(`usages: Go type checker: ${error}`)
  }

  if (unresolved.size) {
    const list = [...unresolved].toSorted()
    log?.(
      `usages: ${list.length} Go import path(s) no go.mod requires, skipped: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ', …' : ''}`,
    )
  }

  const packages = await group({
    dir,
    raw,
    positions: new Map(),
    owners,
    declared,
    versions,
    local,
    replaced: new Set([...replacedLocal].filter((name) => !definedLocal.has(name))),
    localVersions: new Map(),
    ecosystem: 'Go',
  })
  return { packages, files: files.length, modules: modules.length, problems, types }
}
