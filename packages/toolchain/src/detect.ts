import { readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { Tool, Toolchain } from './types.ts'
import {
  nodeMajorFor,
  nodeVersion,
  pythonMinorFor,
  pythonRange,
  satisfies,
  sdkmanJava,
} from './versions.ts'

/** Reads a repository-relative file; `undefined` when it does not exist or cannot be read. */
export type ReadFile = (file: string) => Promise<string | undefined>
type Read = ReadFile

interface Entry {
  tool: Tool
  /** Used only when no other source names the tool; the winner is checked against `accepts`. */
  fallback?: { accepts: (version: string) => boolean; describe: string }
}

interface Found {
  entries: Entry[]
  /** Defaults implied by the mere presence of a file, e.g. a lockfile. */
  implied: Tool[]
  packageManager?: { name: string; version?: string }
  notes: string[]
  packageJson?: Promise<Record<string, unknown> | undefined>
}

type Source = (read: Read, found: Found) => Promise<void>

const aliases: Record<string, string> = { nodejs: 'node', golang: 'go', rustc: 'rust' }
const toolName = (name: string) => aliases[name] ?? name

/** `20` → `20.99.99`, `3.12` → `3.12.99`: the newest release a version prefix may resolve to. */
const highestOf = (version: string) => {
  const parts = version.split('.')
  while (parts.length < 3) parts.push('99')
  return parts.slice(0, 3).join('.')
}

const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .find(Boolean)

const parseToml = (text: string): unknown => Bun.TOML.parse(text)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const miseValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return miseValue(value[0])
  if (isRecord(value) && typeof value.version === 'string') return value.version
  return undefined
}

const miseFiles = [
  'mise.local.toml',
  'mise.toml',
  '.mise.toml',
  '.config/mise.toml',
  '.config/mise/config.toml',
  '.mise/config.toml',
]

const mise: Source = async (read, found) => {
  for (const file of miseFiles) {
    const text = await read(file)
    if (text === undefined) continue
    let parsed: unknown
    try {
      parsed = parseToml(text)
    } catch {
      found.notes.push(`${file}: not valid TOML, ignored`)
      continue
    }
    const tools = isRecord(parsed) && isRecord(parsed.tools) ? parsed.tools : {}
    for (const [name, value] of Object.entries(tools)) {
      const version = miseValue(value)
      if (version && version !== 'system')
        found.entries.push({ tool: { name: toolName(name), version, source: file } })
    }
  }
}

const toolVersions: Source = async (read, found) => {
  const text = await read('.tool-versions')
  if (text === undefined) return
  for (const line of text.split(/\r?\n/)) {
    const [name, ...versions] = line.replace(/#.*/, '').trim().split(/\s+/)
    const version = versions.find((v) => v && v !== 'system')
    if (name && version)
      found.entries.push({ tool: { name: toolName(name), version, source: '.tool-versions' } })
  }
}

const packageJson = (read: Read, found: Found) => {
  found.packageJson ??= read('package.json').then((text) => {
    if (text === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(text)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      found.notes.push('package.json: not valid JSON, ignored')
      return undefined
    }
  })
  return found.packageJson
}

const packageManagerField: Source = async (read, found) => {
  const field = (await packageJson(read, found))?.packageManager
  if (typeof field !== 'string') return
  const match = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(field.trim())
  if (!match) {
    found.notes.push(`package.json: unsupported packageManager "${field}"`)
    return
  }
  const [, name = '', version = ''] = match
  found.packageManager = { name, version }
  if (name !== 'npm') found.entries.push({ tool: { name, version, source: 'package.json' } })
}

const nodeVersionFiles: Source = async (read, found) => {
  for (const file of ['.nvmrc', '.node-version']) {
    const text = await read(file)
    if (text === undefined) continue
    const raw = firstLine(text) ?? ''
    const version = nodeVersion(raw)
    if (version) found.entries.push({ tool: { name: 'node', version, source: file } })
    else found.notes.push(`${file}: cannot use "${raw}"`)
  }
}

const engines: Source = async (read, found) => {
  const range = (await packageJson(read, found))?.engines
  const node = isRecord(range) ? range.node : undefined
  if (typeof node !== 'string') return
  const version = nodeMajorFor(node)
  if (!version) {
    found.notes.push(`package.json: engines.node "${node}" matches no known Node.js major`)
    return
  }
  found.entries.push({
    tool: { name: 'node', version, source: 'package.json' },
    fallback: {
      accepts: (v) => !/^\d/.test(v) || satisfies(highestOf(v), node),
      describe: `engines.node "${node}"`,
    },
  })
}

const volta: Source = async (read, found) => {
  const pins = (await packageJson(read, found))?.volta
  if (!isRecord(pins)) return
  for (const name of ['node', 'pnpm', 'yarn'] as const) {
    const raw = pins[name]
    if (typeof raw !== 'string') continue
    const version = name === 'node' ? nodeVersion(raw) : raw
    if (version) found.entries.push({ tool: { name, version, source: 'package.json' } })
  }
}

const bunLock: Source = async (read, found) => {
  for (const file of ['bun.lock', 'bun.lockb']) {
    if ((await read(file)) === undefined) continue
    const version = found.packageManager?.name === 'bun' ? found.packageManager.version : undefined
    found.entries.push({ tool: { name: 'bun', version: version ?? 'latest', source: file } })
    found.packageManager ??= { name: 'bun' }
    return
  }
}

const goMod: Source = async (read, found) => {
  const text = await read('go.mod')
  if (text === undefined) return
  const toolchain = /^toolchain\s+go(\d\S*)/m.exec(text)?.[1]
  const go = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1]
  const version = toolchain ?? go
  if (version) found.entries.push({ tool: { name: 'go', version, source: 'go.mod' } })
}

const pythonVersion: Source = async (read, found) => {
  const text = await read('.python-version')
  const version = text === undefined ? undefined : firstLine(text)
  if (version) found.entries.push({ tool: { name: 'python', version, source: '.python-version' } })
}

const pyproject: Source = async (read, found) => {
  const text = await read('pyproject.toml')
  if (text === undefined) return
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch {
    found.notes.push('pyproject.toml: not valid TOML, ignored')
    return
  }
  if (!isRecord(parsed)) return
  const project = isRecord(parsed.project) ? parsed.project : {}
  const tool = isRecord(parsed.tool) ? parsed.tool : {}
  const poetry = isRecord(tool.poetry) ? tool.poetry : undefined
  const poetryDeps = poetry && isRecord(poetry.dependencies) ? poetry.dependencies : {}
  const specifier = project['requires-python'] ?? poetryDeps.python
  if (poetry) found.implied.push({ name: 'poetry', version: 'latest', source: 'pyproject.toml' })
  if (typeof specifier !== 'string') return
  const version = pythonMinorFor(specifier)
  if (!version) {
    found.notes.push(`pyproject.toml: Python "${specifier}" matches no known Python 3 minor`)
    return
  }
  found.entries.push({
    tool: { name: 'python', version, source: 'pyproject.toml' },
    fallback: {
      accepts: (v) => !/^\d/.test(v) || satisfies(highestOf(v), pythonRange(specifier)),
      describe: `requires-python "${specifier}"`,
    },
  })
}

const rustToolchain: Source = async (read, found) => {
  for (const file of ['rust-toolchain.toml', 'rust-toolchain']) {
    const text = await read(file)
    if (text === undefined) continue
    let channel: string | undefined
    if (file.endsWith('.toml') || text.trimStart().startsWith('[')) {
      try {
        const parsed = parseToml(text)
        const toolchain = isRecord(parsed) && isRecord(parsed.toolchain) ? parsed.toolchain : {}
        channel = typeof toolchain.channel === 'string' ? toolchain.channel : undefined
      } catch {
        found.notes.push(`${file}: not valid TOML, ignored`)
      }
    } else {
      channel = firstLine(text)
    }
    if (channel) found.entries.push({ tool: { name: 'rust', version: channel, source: file } })
  }
}

const javaVersion: Source = async (read, found) => {
  const text = await read('.java-version')
  const raw = text === undefined ? undefined : firstLine(text)
  if (raw)
    found.entries.push({
      tool: { name: 'java', version: raw.replace(/^1\.8(\..*)?$/, '8'), source: '.java-version' },
    })
}

const sdkmanrc: Source = async (read, found) => {
  const text = await read('.sdkmanrc')
  if (text === undefined) return
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w-]+)\s*=\s*(\S+)/.exec(line.replace(/#.*/, ''))
    if (!match) continue
    const [, name = '', raw = ''] = match
    const version = name === 'java' ? sdkmanJava(raw) : raw
    found.entries.push({ tool: { name, version, source: '.sdkmanrc' } })
  }
}

const rubyVersion: Source = async (read, found) => {
  const text = await read('.ruby-version')
  const raw = text === undefined ? undefined : firstLine(text)
  if (raw)
    found.entries.push({
      tool: { name: 'ruby', version: raw.replace(/^ruby-/, ''), source: '.ruby-version' },
    })
}

const implied: Source = async (read, found) => {
  const has = async (file: string) => (await read(file)) !== undefined
  if (await has('package.json'))
    found.implied.push({ name: 'node', version: 'lts', source: 'package.json' })
  if (await has('pnpm-lock.yaml')) {
    found.implied.push({ name: 'pnpm', version: 'latest', source: 'pnpm-lock.yaml' })
    found.packageManager ??= { name: 'pnpm' }
  }
  const yarnLock = await read('yarn.lock')
  if (yarnLock !== undefined) {
    const classic = yarnLock.includes('# yarn lockfile v1')
    found.implied.push({ name: 'yarn', version: classic ? '1' : 'latest', source: 'yarn.lock' })
    found.packageManager ??= { name: 'yarn' }
  }
  if (await has('package-lock.json')) found.packageManager ??= { name: 'npm' }
  if (await has('uv.lock')) found.implied.push({ name: 'uv', version: 'latest', source: 'uv.lock' })
  if (await has('poetry.lock'))
    found.implied.push({ name: 'poetry', version: 'latest', source: 'poetry.lock' })
  if (await has('Cargo.toml'))
    found.implied.push({ name: 'rust', version: 'stable', source: 'Cargo.toml' })
}

/** Highest priority first. */
const sources: Source[] = [
  mise,
  toolVersions,
  packageManagerField,
  nodeVersionFiles,
  engines,
  volta,
  bunLock,
  goMod,
  pythonVersion,
  pyproject,
  rustToolchain,
  javaVersion,
  sdkmanrc,
  rubyVersion,
  implied,
]

/** Files whose presence makes a directory a (sub-)project worth detecting. */
export const toolchainFiles: ReadonlySet<string> = new Set([
  ...miseFiles.filter((file) => !file.includes('/')),
  '.tool-versions',
  'package.json',
  '.nvmrc',
  '.node-version',
  'bun.lock',
  'bun.lockb',
  'go.mod',
  '.python-version',
  'pyproject.toml',
  'rust-toolchain.toml',
  'rust-toolchain',
  'Cargo.toml',
  '.java-version',
  '.sdkmanrc',
  '.ruby-version',
])

interface Project {
  tools: Tool[]
  implied: Tool[]
  packageManager?: { name: string; version?: string }
  notes: string[]
}

async function detectProject(read: Read, prefix: string): Promise<Project> {
  const found: Found = { entries: [], implied: [], notes: [] }
  for (const source of sources) await source(read, found)

  const byName = new Map<string, Entry[]>()
  for (const entry of found.entries) {
    const list = byName.get(entry.tool.name) ?? []
    list.push(entry)
    byName.set(entry.tool.name, list)
  }
  const at = (source: string) => (prefix ? posix.join(prefix, source) : source)
  const notes = found.notes.map((note) => (prefix ? `${prefix}/${note}` : note))
  const tools: Tool[] = []
  for (const [name, entries] of byName) {
    const winner = entries.find((entry) => !entry.fallback) ?? entries[0]
    if (!winner) continue
    for (const entry of entries) {
      if (entry === winner) continue
      if (entry.fallback) {
        if (!entry.fallback.accepts(winner.tool.version))
          notes.push(
            `${name} ${winner.tool.version} from ${at(winner.tool.source)} does not satisfy ${entry.fallback.describe} in ${at(entry.tool.source)}`,
          )
      } else if (entry.tool.version !== winner.tool.version) {
        notes.push(
          `${at(entry.tool.source)} asks for ${name} ${entry.tool.version}; using ${winner.tool.version} from ${at(winner.tool.source)}`,
        )
      }
    }
    tools.push({ ...winner.tool, source: at(winner.tool.source) })
  }
  const named = new Set(tools.map((tool) => tool.name))
  const defaults: Tool[] = []
  for (const tool of found.implied) {
    if (named.has(tool.name) || defaults.some((t) => t.name === tool.name)) continue
    defaults.push({ name: tool.name, version: tool.version, source: at(tool.source) })
  }
  return {
    tools,
    implied: defaults,
    ...(found.packageManager && { packageManager: found.packageManager }),
    notes,
  }
}

const skippedDirs = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out'])
const isSkipped = (segment: string) => skippedDirs.has(segment) || segment.startsWith('.')

async function walk(dir: string, maxDepth: number): Promise<string[]> {
  const files: string[] = []
  const visit = async (relative: string, depth: number) => {
    let names: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      names = await readdir(join(dir, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isFile()) files.push(path)
      else if (entry.isDirectory() && depth < maxDepth && !isSkipped(entry.name))
        await visit(path, depth + 1)
    }
  }
  await visit('', 0)
  return files
}

/** Directories (repository-relative, without the root) that contain a toolchain file. */
export function subProjects(files: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
    const dir = posix.dirname(normalized)
    if (dir === '.' || !toolchainFiles.has(posix.basename(normalized))) continue
    if (dir.split('/').some(isSkipped)) continue
    dirs.add(dir)
  }
  return [...dirs].toSorted()
}

const reader =
  (dir: string): Read =>
  async (file) => {
    try {
      return await readFile(join(dir, file), 'utf8')
    } catch {
      return undefined
    }
  }

/**
 * Detects the tools a checkout needs from its version files. The root project wins; sub-projects
 * (directories with their own version files, from `files` when given — repository-relative paths —
 * otherwise found by walking three levels deep) add tools the root does not name, and every
 * disagreement is reported in `notes`. Never throws for unreadable or malformed files.
 */
export async function detectToolchain(dir: string, files?: readonly string[]): Promise<Toolchain> {
  return detectToolchainFrom(reader(dir), files ?? (await walk(dir, 3)))
}

/**
 * `detectToolchain` over any file source, e.g. a forge API: `read` gets repository-relative paths
 * and `files` lists the repository's files (only the root project is read when it is empty).
 */
export async function detectToolchainFrom(
  read: ReadFile,
  files: readonly string[],
): Promise<Toolchain> {
  const root = await detectProject(read, '')
  const tools = [...root.tools]
  const notes = [...root.notes]
  let packageManager = root.packageManager
  const defaults = [...root.implied]

  for (const sub of subProjects(files)) {
    const project = await detectProject((file) => read(posix.join(sub, file)), sub)
    notes.push(...project.notes)
    for (const tool of project.tools) {
      const existing = tools.find((t) => t.name === tool.name)
      if (!existing) {
        tools.push(tool)
        continue
      }
      if (existing.version !== tool.version)
        notes.push(
          `${tool.source} asks for ${tool.name} ${tool.version}; using ${existing.version} from ${existing.source}`,
        )
    }
    for (const tool of project.implied)
      if (!defaults.some((t) => t.name === tool.name)) defaults.push(tool)
    packageManager ??= project.packageManager
  }

  for (const tool of defaults) {
    if (tools.some((t) => t.name === tool.name)) continue
    tools.push(tool)
    notes.push(`${tool.name} ${tool.version}: no version pinned, implied by ${tool.source}`)
  }
  return { tools, ...(packageManager && { packageManager }), notes }
}
