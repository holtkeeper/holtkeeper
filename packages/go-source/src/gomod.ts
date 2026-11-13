import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

/** One `require` of a `go.mod`. */
export interface GoRequire {
  path: string
  version: string
  /** Marked `// indirect`: no package of the main module imports it directly. */
  indirect?: true
}

/** One `replace` of a `go.mod`: `path [version] => to [toVersion]`. */
export interface GoReplace {
  path: string
  /** Only this version is replaced; every version when absent. */
  version?: string
  /** Module path, or a directory relative to the `go.mod` (or absolute) when `local`. */
  to: string
  /** Version of the replacement module; absent for a local replacement. */
  toVersion?: string
  /** The replacement is a directory (`./x`, `../x` or an absolute path), not a module. */
  local: boolean
}

/** What this package reads from a `go.mod`. */
export interface GoMod {
  module: string
  /** Version of the `go` directive, when present. */
  go?: string
  /** Required module paths with versions, in file order. */
  require: GoRequire[]
  replace: GoReplace[]
  exclude: { path: string; version: string }[]
}

/** A module of the repository: one `use` of `go.work`, or one `go.mod` found in the tree. */
export interface GoWorkspaceModule {
  /** Module path from the `module` directive. */
  module: string
  /** Directory relative to the analyzed directory, `.` for the root. */
  dir: string
  mod: GoMod
}

interface DirectiveLine {
  text: string
  comment: string
}

const splitComment = (line: string): DirectiveLine => {
  const at = line.indexOf('//')
  return at < 0
    ? { text: line.trim(), comment: '' }
    : { text: line.slice(0, at).trim(), comment: line.slice(at + 2).trim() }
}

const unquote = (text: string) =>
  text.startsWith('"') || text.startsWith('`') ? text.slice(1, -1) : text

/** Lines of a directive, from both `name x` and `name ( ... )` forms, with their comments. */
function directive(content: string, name: string): DirectiveLine[] {
  const values: DirectiveLine[] = []
  let inBlock = false
  for (const raw of content.split(/\r?\n/)) {
    const line = splitComment(raw)
    if (inBlock) {
      if (line.text === ')') inBlock = false
      else if (line.text) values.push(line)
      continue
    }
    if (/^\(\s*$/.test(line.text.slice(name.length).trim()) && line.text.startsWith(name))
      inBlock = true
    else if (line.text.startsWith(`${name} `) || line.text.startsWith(`${name}\t`))
      values.push({ text: line.text.slice(name.length + 1).trim(), comment: line.comment })
  }
  return values
}

const isLocalPath = (path: string) =>
  path.startsWith('./') ||
  path.startsWith('../') ||
  path === '.' ||
  path === '..' ||
  path.startsWith('/') ||
  /^[A-Za-z]:[\\/]/.test(path)

const tokens = (text: string) => text.split(/\s+/).filter(Boolean).map(unquote)

/** Parses the `module`, `go`, `require`, `replace` and `exclude` directives of a `go.mod`. */
export function parseGoMod(content: string): GoMod {
  const [module = ''] = directive(content, 'module').map((line) => unquote(line.text))
  const go = directive(content, 'go')[0]?.text
  const require = directive(content, 'require').flatMap(({ text, comment }): GoRequire[] => {
    const [path, version] = tokens(text)
    if (!path || !version) return []
    const indirect = comment.split(';').some((part) => part.trim() === 'indirect')
    return [{ path, version, ...(indirect ? { indirect: true as const } : {}) }]
  })
  const replace = directive(content, 'replace').flatMap(({ text }): GoReplace[] => {
    const arrow = text.indexOf('=>')
    if (arrow < 0) return []
    const [path, version] = tokens(text.slice(0, arrow))
    const [to, toVersion] = tokens(text.slice(arrow + 2))
    if (!path || !to) return []
    const local = !toVersion && isLocalPath(to)
    return [
      {
        path,
        ...(version ? { version } : {}),
        to,
        ...(toVersion ? { toVersion } : {}),
        local,
      },
    ]
  })
  const exclude = directive(content, 'exclude').flatMap(({ text }) => {
    const [path, version] = tokens(text)
    return path && version ? [{ path, version }] : []
  })
  return { module, ...(go ? { go } : {}), require, replace, exclude }
}

/** Directories listed by the `use` directives of a `go.work`, normalized relative paths. */
export function parseGoWork(content: string): string[] {
  return directive(content, 'use').map((line) =>
    posix.normalize(unquote(line.text.split(/\s+/)[0] ?? '')),
  )
}

const skipped = new Set(['node_modules', 'vendor', 'testdata', '.git'])

/** Directories under `dir` (relative, `.` first) that contain a `go.mod`, at most `depth` deep. */
export async function findGoModules(dir: string, depth = 4): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string, level: number): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.isFile() && entry.name === 'go.mod')) found.push(relative)
    if (level >= depth) return
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name)))
      if (entry.isDirectory() && !skipped.has(entry.name) && !entry.name.startsWith('.'))
        await walk(relative === '.' ? entry.name : `${relative}/${entry.name}`, level + 1)
  }
  await walk('.', 0)
  return found
}

/** Reads the `go.mod` of each directory; directories without one are skipped. */
export async function readGoModules(
  dir: string,
  dirs: readonly string[],
): Promise<GoWorkspaceModule[]> {
  const modules = await Promise.all(
    dirs.map(async (moduleDir): Promise<GoWorkspaceModule[]> => {
      const file = Bun.file(join(dir, moduleDir, 'go.mod'))
      if (!(await file.exists())) return []
      const mod = parseGoMod(await file.text())
      return mod.module ? [{ module: mod.module, dir: moduleDir, mod }] : []
    }),
  )
  return modules.flat()
}

/**
 * Modules of the repository at `dir`: the `use` directories of a root `go.work` when there is
 * one, otherwise every `go.mod` up to `depth` (default 4) directories deep. `workspace` tells
 * which of the two it was.
 */
export async function discoverGoModules(
  dir: string,
  depth = 4,
): Promise<{ workspace: boolean; modules: GoWorkspaceModule[] }> {
  const work = Bun.file(join(dir, 'go.work'))
  if (await work.exists())
    return { workspace: true, modules: await readGoModules(dir, parseGoWork(await work.text())) }
  return { workspace: false, modules: await readGoModules(dir, await findGoModules(dir, depth)) }
}
