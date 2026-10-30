import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

/** What this package reads from a `go.mod`. */
export interface GoMod {
  module: string
  /** Required module paths with versions, in file order. */
  require: { path: string; version: string }[]
}

/** A module of the repository: one `use` of `go.work`, or one `go.mod` found in the tree. */
export interface GoWorkspaceModule {
  /** Module path from the `module` directive. */
  module: string
  /** Directory relative to the analyzed directory, `.` for the root. */
  dir: string
  mod: GoMod
}

const stripComment = (line: string) => line.replace(/\/\/.*$/, '').trim()
const unquote = (text: string) =>
  text.startsWith('"') || text.startsWith('`') ? text.slice(1, -1) : text

/** Lines of a directive, from both `name x` and `name ( ... )` forms. */
function directive(content: string, name: string): string[] {
  const values: string[] = []
  let inBlock = false
  for (const raw of content.split(/\r?\n/)) {
    const line = stripComment(raw)
    if (inBlock) {
      if (line === ')') inBlock = false
      else if (line) values.push(line)
      continue
    }
    if (line === `${name} (`) inBlock = true
    else if (line.startsWith(`${name} `)) values.push(line.slice(name.length + 1).trim())
  }
  return values
}

/** Parses the `module` and `require` directives of a `go.mod`. */
export function parseGoMod(content: string): GoMod {
  const [module = ''] = directive(content, 'module').map(unquote)
  const require = directive(content, 'require').flatMap((line) => {
    const [path, version] = line.split(/\s+/)
    return path && version ? [{ path: unquote(path), version }] : []
  })
  return { module, require }
}

/** Directories listed by the `use` directives of a `go.work`, normalized relative paths. */
export function parseGoWork(content: string): string[] {
  return directive(content, 'use').map((line) =>
    posix.normalize(unquote(line.split(/\s+/)[0] ?? '')),
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
