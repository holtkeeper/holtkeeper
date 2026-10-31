import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

/** A `package.json` of the checkout with the fields the extractor reads. */
export interface PackageManifest {
  name: string
  version?: string
  description?: string
  private: boolean
  /** Folder relative to the checkout, `/`-separated; `.` for the root. */
  dir: string
  /** Entry point per subpath, as files relative to the package folder; may not exist. */
  entries: { subpath: string; targets: string[] }[]
  /** `exports` subpaths with a single `*`, e.g. `./*` → `./dist/*`; expand with `expandWildcard`. */
  wildcards: { subpath: string; targets: string[] }[]
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

const conditions = ['types', 'typings', 'import', 'module', 'node', 'default', 'require']

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts']

const ignoredFolders = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage'])

const built = /^(?:\.\/)?(?:dist|lib|build|out|esm|cjs)(?:\/(?:esm|cjs))?\//

const maxWildcardEntries = 200

const maxWildcardDepth = 2

const stars = (value: string) => value.split('*').length - 1

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Targets of one `exports` value, most specific condition first. */
function targetsOf(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => targetsOf(item))
  if (!isRecord(value)) return []
  const keys = Object.keys(value)
  const ordered = [
    ...conditions.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !conditions.includes(key)),
  ]
  return ordered.flatMap((key) => targetsOf(value[key]))
}

function entriesOf(manifest: Record<string, Json>): Pick<PackageManifest, 'entries' | 'wildcards'> {
  const exports = manifest.exports
  if (exports !== undefined && exports !== null) {
    if (isRecord(exports) && Object.keys(exports).some((key) => key.startsWith('.'))) {
      const all = Object.entries(exports)
        .filter(([subpath]) => subpath.startsWith('.') && subpath !== './package.json')
        .map(([subpath, value]) => ({ subpath, targets: targetsOf(value) }))
        .filter((entry) => entry.targets.length > 0)
      return {
        entries: all.filter((entry) => !entry.subpath.includes('*')),
        wildcards: all
          .filter((entry) => stars(entry.subpath) === 1)
          .map((entry) => ({ ...entry, targets: entry.targets.filter((t) => stars(t) === 1) }))
          .filter((entry) => entry.targets.length > 0),
      }
    }
    return { entries: [{ subpath: '.', targets: targetsOf(exports) }], wildcards: [] }
  }
  const fields = ['types', 'typings', 'module', 'main']
    .map((field) => manifest[field])
    .filter((value): value is string => typeof value === 'string')
  return {
    entries: [{ subpath: '.', targets: [...fields, 'src/index.ts', 'index.ts', 'index.d.ts'] }],
    wildcards: [],
  }
}

async function readManifest(path: string, root: string): Promise<PackageManifest | undefined> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || !parsed.name) return undefined
  const dir = relative(root, dirname(path)).split('\\').join('/') || '.'
  return {
    name: parsed.name,
    ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
    ...(typeof parsed.description === 'string' && parsed.description
      ? { description: parsed.description }
      : {}),
    private: parsed.private === true,
    dir,
    ...entriesOf(parsed),
  }
}

async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = []
  const rootManifest = join(root, 'package.json')
  if (existsSync(rootManifest)) {
    const parsed: unknown = JSON.parse(await readFile(rootManifest, 'utf8'))
    if (isRecord(parsed)) {
      const workspaces = parsed.workspaces
      const list = isRecord(workspaces) ? workspaces.packages : workspaces
      if (Array.isArray(list))
        patterns.push(...list.filter((item): item is string => typeof item === 'string'))
    }
  }
  const pnpm = join(root, 'pnpm-workspace.yaml')
  if (existsSync(pnpm)) {
    const text = await readFile(pnpm, 'utf8')
    const block = /^packages:\s*\n((?:\s+-.*\n?)+)/m.exec(text)?.[1] ?? ''
    for (const line of block.split('\n')) {
      const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line)?.[1]
      if (item) patterns.push(item)
    }
  }
  return patterns
}

/**
 * Packages of a checkout: the root `package.json` and every workspace that `package.json`
 * `workspaces` or `pnpm-workspace.yaml` lists (negated patterns excluded). Packages without a
 * `name` are skipped. Sorted by folder.
 */
export async function findPackages(root: string): Promise<PackageManifest[]> {
  const found = new Map<string, PackageManifest>()
  const add = async (path: string) => {
    const manifest = await readManifest(path, root).catch(() => undefined)
    if (manifest) found.set(manifest.dir, manifest)
  }
  if (existsSync(join(root, 'package.json'))) await add(join(root, 'package.json'))
  const patterns = await workspacePatterns(root)
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => new Bun.Glob(pattern.slice(1).replace(/\/+$/, '')))
  for (const pattern of patterns.filter((item) => !item.startsWith('!'))) {
    const glob = new Bun.Glob(`${pattern.replace(/^\.\//, '').replace(/\/+$/, '')}/package.json`)
    for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
      const dir = dirname(path)
      if (dir.split('/').some((part) => ignoredFolders.has(part))) continue
      if (excluded.some((skip) => skip.match(dir))) continue
      await add(join(root, path))
    }
  }
  return [...found.values()].toSorted((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * The source file an entry target resolves to inside `packageDir`: the file itself when it is
 * TypeScript, else a declaration next to it, else the TypeScript source a build would have
 * compiled it from (`dist/x.js` → `src/x.ts`, then `x.ts` at the package root), else the
 * JavaScript file. `undefined` when none exists, e.g. for a build output missing from the
 * checkout.
 */
export function resolveEntry(packageDir: string, target: string): string | undefined {
  const path = join(packageDir, target)
  const candidates: string[] = []
  const stem = path.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, '')
  if (/\.[cm]?tsx?$/.test(path)) candidates.push(path)
  candidates.push(`${stem}.d.ts`, `${stem}.d.mts`, `${stem}.d.cts`)
  const relativeStem = relative(packageDir, stem).split('\\').join('/')
  if (built.test(relativeStem))
    for (const source of [relativeStem.replace(built, 'src/'), relativeStem.replace(built, '')])
      for (const extension of ['.ts', '.tsx', '.mts', '.d.ts', '/index.ts', '/index.tsx'])
        candidates.push(join(packageDir, `${source}${extension}`))
  for (const extension of sourceExtensions) candidates.push(`${stem}${extension}`)
  candidates.push(join(stem, 'index.ts'), join(stem, 'index.d.ts'), path)
  return candidates.find(isFile)
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const moduleFile = /\.(?:d\.)?[cm]?[jt]sx?$/

const skippedModule = /^[._]|^index$|\.(?:test|spec|stories|config)$/

const listDir = (path: string) => {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * The entry points a wildcard `exports` subpath (`./*` → `./dist/*`) stands for: one per module
 * file or folder with an index in the folder its target points to, or in the source folder a build
 * would have compiled it from (`src/`, then the package root). Folders without an index are
 * searched two levels deep (`./desktop/Button`). Tests, stories, configs, `index` and names
 * starting with `.` or `_` are skipped; at most 200 entries, sorted by subpath.
 */
export function expandWildcard(
  packageDir: string,
  wildcard: { subpath: string; targets: string[] },
): { subpath: string; file: string }[] {
  const found = new Map<string, string>()
  for (const target of wildcard.targets) {
    const [prefix = '', suffix = ''] = target.split('*')
    if (prefix && !prefix.endsWith('/')) continue
    const folder = prefix.replace(/^\.\//, '')
    const folders = built.test(folder)
      ? [folder, folder.replace(built, 'src/'), folder.replace(built, '')]
      : [folder]
    const visited = new Set<string>()
    const visit = (nested: string, depth: number) => {
      for (const entry of folders.flatMap((dir) => listDir(join(packageDir, dir, nested)))) {
        if (!entry.isDirectory() && !moduleFile.test(entry.name)) continue
        if (entry.isDirectory() && ignoredFolders.has(entry.name)) continue
        const base = entry.isDirectory() ? entry.name : entry.name.replace(moduleFile, '')
        if (skippedModule.test(base)) continue
        const name = `${nested}${base}`
        const subpath = wildcard.subpath.replace('*', name)
        if (found.has(subpath)) continue
        const file = resolveEntry(packageDir, `${prefix}${name}${suffix}`)
        if (file) found.set(subpath, file)
        else if (entry.isDirectory() && depth < maxWildcardDepth && !visited.has(name)) {
          visited.add(name)
          visit(`${name}/`, depth + 1)
        }
      }
    }
    visit('', 1)
  }
  return [...found]
    .map(([subpath, file]) => ({ subpath, file }))
    .toSorted((a, b) => a.subpath.localeCompare(b.subpath))
    .slice(0, maxWildcardEntries)
}
