import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import {
  API,
  type Checker,
  type Project,
  type Symbol as CheckerSymbol,
  SymbolFlags,
} from 'typescript/unstable/async'

import type { UsageKind } from './model.ts'
import type { Candidate } from './scan.ts'

/** A workspace of the checkout, for telling its own packages from installed ones. */
export interface TypedWorkspace {
  name: string
  /** Relative to the checkout, `.` for the root. */
  path: string
}

/** A use the type checker tied to a package export. */
export interface TypedSite {
  file: string
  offset: number
  package: string
  export: string
  member?: string
  kind: UsageKind
  props?: string[]
  spread?: boolean
}

/** What `resolveTypes` did. */
export interface TypesOutcome {
  status: 'used' | 'skipped' | 'failed'
  reason?: string
  projects: string[]
  sites: TypedSite[]
}

const ignoredFolders = /(^|\/)(node_modules|dist|build|out|coverage|\.git)\//

/** `tsconfig*.json` at the root and in each workspace. */
async function findProjects(dir: string, workspaces: readonly TypedWorkspace[]) {
  const found = new Set<string>()
  for (const workspace of workspaces) {
    const base = workspace.path === '.' ? '' : `${workspace.path}/`
    for await (const file of new Bun.Glob(`${base}tsconfig*.json`).scan({
      cwd: dir,
      onlyFiles: true,
    }))
      if (!ignoredFolders.test(file)) found.add(file.replaceAll('\\', '/'))
  }
  return [...found].toSorted()
}

/**
 * The package a declaration file belongs to: the last `node_modules/<name>` in its path (with
 * `@types/x` standing for `x`), or a workspace of the checkout. Compared case-insensitively, as
 * the checker reports paths in lower case on case-insensitive file systems.
 */
export function packageOfPath(
  path: string,
  workspaces: readonly { name: string; root: string }[],
): string | undefined {
  const normalized = path.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()
  const at = lower.lastIndexOf('/node_modules/')
  if (at >= 0) {
    const parts = normalized.slice(at + '/node_modules/'.length).split('/')
    const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (!name || name.startsWith('.')) return undefined
    if (name.startsWith('@types/')) {
      const typed = name.slice('@types/'.length)
      return typed.includes('__') ? `@${typed.replace('__', '/')}` : typed
    }
    return name
  }
  const owner = workspaces
    .filter((workspace) => lower.startsWith(`${workspace.root}/`))
    .toSorted((a, b) => b.root.length - a.root.length)[0]
  return owner?.name
}

/** Export name for members of a type literal or object the package never names. */
export const anonymous = '(anonymous)'

const memberFlags =
  SymbolFlags.Property | SymbolFlags.Method | SymbolFlags.GetAccessor | SymbolFlags.SetAccessor

const defaultLibrary = /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/i

interface Resolved {
  package: string
  export: string
  member?: string
}

/**
 * Asks the TypeScript 7 checker (tsgo, through its API) what the `candidates` of each file refer
 * to and keeps the ones declared in a package: a method of the object a hook returns, a component
 * imported through a local barrel or a `paths` alias, a type reached through inference. Needs the
 * dependencies installed and a `tsconfig.json`; reports `skipped` otherwise. Files outside every
 * project are left out. Uses of a workspace's own package from inside it are not counted.
 */
export async function resolveTypes(options: {
  dir: string
  workspaces: readonly TypedWorkspace[]
  files: ReadonlyMap<string, { workspace: string; candidates: readonly Candidate[] }>
  /** Packages worth reporting, e.g. the declared dependencies; others are dropped. */
  known: (name: string) => boolean
  signal?: AbortSignal
}): Promise<TypesOutcome> {
  const { dir, workspaces, files, known, signal } = options
  const projects = await findProjects(dir, workspaces)
  if (!projects.length)
    return { status: 'skipped', reason: 'no tsconfig.json', projects, sites: [] }
  if (!existsSync(join(dir, 'node_modules')))
    return { status: 'skipped', reason: 'dependencies are not installed', projects, sites: [] }

  const real = realpathSync(dir)
  const roots = workspaces
    .filter((workspace) => workspace.path !== '.')
    .map((workspace) => ({
      name: workspace.name,
      root: join(real, workspace.path).replaceAll('\\', '/').toLowerCase(),
    }))
  const api = new API({ cwd: real })
  const sites: TypedSite[] = []
  try {
    const snapshot = await api.updateSnapshot({
      openProjects: projects.map((file) => join(real, file)),
    })
    const owners = new Map<string, Project>()
    for (const project of snapshot.getProjects())
      // oxlint-disable-next-line no-await-in-loop -- a handful of projects
      for (const name of await project.program.getSourceFileNames())
        if (!owners.has(name.toLowerCase())) owners.set(name.toLowerCase(), project)

    const cache = new Map<number, Resolved | null>()
    for (const [file, { workspace, candidates }] of files) {
      signal?.throwIfAborted()
      if (!candidates.length) continue
      const absolute = join(real, file)
      const project = owners.get(absolute.replaceAll('\\', '/').toLowerCase())
      if (!project) continue
      const { checker } = project
      // oxlint-disable-next-line no-await-in-loop -- one batched request per file keeps the server's memory flat
      const symbols = await checker.getSymbolAtPosition(
        absolute,
        candidates.map((c) => c.offset),
      )
      for (const [index, symbol] of symbols.entries()) {
        const candidate = candidates[index]
        if (!symbol || !candidate) continue
        let resolved = cache.get(symbol.id)
        if (resolved === undefined) {
          // oxlint-disable-next-line no-await-in-loop -- symbols resolve once each and are cached
          resolved = await resolveSymbol(checker, symbol, roots)
          cache.set(symbol.id, resolved)
        }
        if (!resolved || resolved.package === workspace || !known(resolved.package)) continue
        sites.push({
          file,
          offset: candidate.offset,
          package: resolved.package,
          export: resolved.export,
          ...(resolved.member ? { member: resolved.member } : {}),
          kind: candidate.kind,
          ...(candidate.props ? { props: candidate.props } : {}),
          ...(candidate.spread ? { spread: true } : {}),
        })
      }
    }
    return { status: 'used', projects, sites }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      projects,
      sites: [],
    }
  } finally {
    await api.close().catch(() => undefined)
  }
}

async function resolveSymbol(
  checker: Checker,
  symbol: CheckerSymbol,
  roots: readonly { name: string; root: string }[],
): Promise<Resolved | null> {
  const target = symbol.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(symbol) : symbol
  if (await checker.isUnknownSymbol(target)) return null
  const declaration = target.declarations[0] ?? target.valueDeclaration
  if (!declaration) return null
  if (defaultLibrary.test(declaration.path)) return null
  const pkg = packageOfPath(declaration.path, roots)
  if (!pkg) return null
  const names = [target.name]
  let parent = await target.getParent()
  for (let depth = 0; parent && depth < 6; depth += 1) {
    if (
      parent.flags & (SymbolFlags.ValueModule | SymbolFlags.NamespaceModule) &&
      parent.name.startsWith('"')
    )
      break
    names.unshift(parent.name)
    // oxlint-disable-next-line no-await-in-loop -- parents are walked one at a time
    parent = await parent.getParent()
  }
  const [first = '', ...rest] = names
  if (first.startsWith('"')) return null
  const memberOnly = names.length === 1 && Boolean(target.flags & memberFlags)
  if (memberOnly) return { package: pkg, export: anonymous, member: first }
  const exported = first.startsWith('__') ? anonymous : first
  const members = rest.filter((name) => !name.startsWith('__'))
  if (exported === anonymous && !members.length) return null
  return {
    package: pkg,
    export: exported,
    ...(members.length ? { member: members.join('.') } : {}),
  }
}
