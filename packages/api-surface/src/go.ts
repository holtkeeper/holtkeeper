import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import {
  compareGoVersions,
  discoverGoModules,
  type GoWorkspaceModule,
  goModuleApi,
  goModuleTags,
} from '@holtkeeper/go-source'

import type { ApiGoModule, ApiPackage } from './model.ts'

/** Options of `extractGoApi`. */
export interface ExtractGoApiOptions {
  /** Checkout root. */
  dir: string
  /** List packages under `internal/` with `private: true`. Default `true`. */
  includeInternal?: boolean
  /** Glob patterns of package import paths to keep; all when empty. */
  packages?: readonly string[]
  /** Glob patterns of package folders (relative to the checkout) to leave out. */
  exclude?: readonly string[]
  /** Version per module directory (`.` for the root), e.g. from `goModuleVersions`. */
  versions?: ReadonlyMap<string, string>
  /** Called once with the modules found when `versions` is absent and there are modules. */
  resolveVersions?: (
    modules: readonly GoWorkspaceModule[],
  ) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>
  /** How deep `go.mod` files are looked for when there is no `go.work`. Default 4. */
  depth?: number
}

/** What `extractGoApi` found: the Go packages of the checkout and its modules with counts. */
export interface GoApiExtraction {
  packages: ApiPackage[]
  modules: ApiGoModule[]
}

const skippedDir = (name: string) =>
  name === 'vendor' ||
  name === 'testdata' ||
  name === 'node_modules' ||
  name.startsWith('.') ||
  name.startsWith('_')

const maxFiles = 20_000

async function readModuleFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => [])
    if (relative && entries.some((entry) => entry.isFile() && entry.name === 'go.mod')) return
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (files.size >= maxFiles) return
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // oxlint-disable-next-line no-await-in-loop -- one directory at a time keeps file order stable
        if (!skippedDir(entry.name)) await walk(path)
      } else if (
        entry.isFile() &&
        ((entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) ||
          (!relative && entry.name === 'go.mod'))
      )
        // oxlint-disable-next-line no-await-in-loop -- bounded by maxFiles
        files.set(path, await Bun.file(join(root, path)).bytes())
    }
  }
  await walk('')
  return files
}

const under = (moduleDir: string, path: string) =>
  moduleDir === '.' ? path : path === '.' ? moduleDir : `${moduleDir}/${path}`

const prefixPackage = (moduleDir: string, pkg: ApiPackage): ApiPackage =>
  moduleDir === '.'
    ? pkg
    : {
        ...pkg,
        dir: under(moduleDir, pkg.dir),
        entries: pkg.entries.map((entry) => ({
          ...entry,
          ...(entry.file ? { file: under(moduleDir, entry.file) } : {}),
          symbols: entry.symbols.map((symbol) => ({
            ...symbol,
            file: under(moduleDir, symbol.file),
          })),
        })),
        ...(pkg.problems
          ? { problems: pkg.problems.map((problem) => under(moduleDir, problem)) }
          : {}),
      }

/**
 * The public API of every Go module in a checkout: the `go.work` members, else every `go.mod` up
 * to `depth` directories deep. Each module is read without the subtrees of nested modules,
 * `vendor/`, `testdata/` and test files, and yields one `ApiPackage` per library package as
 * `goModuleApi` describes it, with `dir` and `file` relative to the checkout. Packages under
 * `internal/` are listed as private unless `includeInternal` is false; `package main` directories
 * are only counted. `modules` lists every module found, even one without importable packages, so
 * a service reads as "internal only" rather than empty. Nothing is built and no Go toolchain is
 * needed.
 */
export async function extractGoApi(options: ExtractGoApiOptions): Promise<GoApiExtraction> {
  const names = (options.packages ?? []).map((pattern) => new Bun.Glob(pattern))
  const excluded = (options.exclude ?? []).map((pattern) => new Bun.Glob(pattern))
  const { modules } = await discoverGoModules(options.dir, options.depth ?? 4)
  const versions =
    options.versions ??
    (modules.length && options.resolveVersions ? await options.resolveVersions(modules) : undefined)
  const packages: ApiPackage[] = []
  const found: ApiGoModule[] = []
  for (const module of modules) {
    // oxlint-disable-next-line no-await-in-loop -- one module in memory at a time
    const files = await readModuleFiles(join(options.dir, module.dir))
    const version = versions?.get(module.dir)
    const api = goModuleApi(files, {
      module: module.module,
      ...(version ? { version } : {}),
      includeInternal: options.includeInternal ?? true,
    })
    const kept = api.packages
      .map((pkg) => prefixPackage(module.dir, pkg))
      .filter(
        (pkg) =>
          (!names.length || names.some((glob) => glob.match(pkg.name))) &&
          !excluded.some((glob) => glob.match(pkg.dir)),
      )
    packages.push(...kept)
    found.push({
      path: module.module,
      dir: module.dir,
      ...(version ? { version } : {}),
      packages: api.packages.filter((pkg) => !pkg.private).length,
      internalPackages: api.internalPackages,
      mainPackages: api.mainPackages,
    })
  }
  return { packages, modules: found }
}

/**
 * Version of each module released by `tags`, keyed by module directory, by Go's tagging rules
 * (`goModuleTags`): the highest tag per module wins. With `ref` naming a tag that releases a Go
 * module (a run for that tag), only the module `ref` releases gets a version; otherwise every
 * module with a tag among `tags` does. Modules without a matching tag are left out.
 */
export function goModuleVersions(
  tags: readonly string[],
  modules: readonly Pick<GoWorkspaceModule, 'module' | 'dir'>[],
  ref?: string,
): Map<string, string> {
  const released = goModuleTags(ref && !tags.includes(ref) ? [...tags, ref] : tags, modules)
  const own = ref ? released.filter((tag) => tag.tag === ref) : []
  const versions = new Map<string, string>()
  for (const tag of own.length ? own : released) {
    const current = versions.get(tag.dir)
    if (!current || compareGoVersions(tag.version, current) > 0) versions.set(tag.dir, tag.version)
  }
  return versions
}

/**
 * Tags pointing at the checkout's `HEAD` (`git tag --points-at HEAD`). Empty when git fails or
 * the checkout has no tags; `log` gets one line explaining a failure.
 */
export async function tagsAtHead(
  runner: CommandRunner,
  dir: string,
  log?: (line: string) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const result = await runner.run(['git', 'tag', '--points-at', 'HEAD'], {
      cwd: dir,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
    })
    if (result.exitCode !== 0) {
      log?.(`api-surface: git tag --points-at HEAD failed: ${result.stderr.trim().split('\n')[0]}`)
      return []
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    log?.(`api-surface: git tag --points-at HEAD failed: ${String(error)}`)
    return []
  }
}
