import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { CheckSpec } from './workspace.ts'

/** A check that runs `gofmt -l` over the `.go` files the task changed; it fails when any is listed. */
export const GOFMT_CHECK = 'gofmt'

const skippedDirs = new Set(['node_modules', 'vendor', 'testdata'])

async function findGoMods(dir: string, depth = 4): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string, level: number): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => [])
    if (entries.some((entry) => entry.isFile() && entry.name === 'go.mod')) found.push(relative)
    if (level >= depth) return
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name)))
      if (entry.isDirectory() && !skippedDirs.has(entry.name) && !entry.name.startsWith('.'))
        // oxlint-disable-next-line no-await-in-loop -- keeps the walk in a stable order
        await walk(relative === '.' ? entry.name : `${relative}/${entry.name}`, level + 1)
  }
  await walk('.', 0)
  return found
}

function firstToken(text: string): string {
  const raw = /^`([^`]*)`/.exec(text)
  if (raw) return raw[1]!
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text)
  if (quoted) {
    try {
      const value: unknown = JSON.parse(`"${quoted[1]}"`)
      if (typeof value === 'string') return value
    } catch {}
    return quoted[1]!
  }
  return text.split(/\s+|\/\//)[0]!
}

/** Directories of the `use` directives of a `go.work`, normalized and relative. */
export function goWorkUses(text: string): string[] {
  const uses: string[] = []
  let block = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    if (block) {
      if (/^\)\s*(\/\/.*)?$/.test(line)) block = false
      else uses.push(firstToken(line))
      continue
    }
    if (/^use\s*\(\s*(\/\/.*)?$/.test(line)) block = true
    else if (/^use\s+/.test(line)) uses.push(firstToken(line.slice(3).trim()))
  }
  return uses.filter(Boolean).map((use) => posix.normalize(use))
}

/** The repository's Go modules: the `use` directories of a root `go.work`, else every `go.mod` up to four levels deep. */
async function goModuleDirs(dir: string): Promise<{ workspace: boolean; dirs: string[] }> {
  const work = Bun.file(join(dir, 'go.work'))
  if (await work.exists()) {
    const uses = goWorkUses(await work.text())
    const present = await Promise.all(
      uses.map((use) => Bun.file(join(dir, use, 'go.mod')).exists()),
    )
    return { workspace: true, dirs: uses.filter((_, index) => present[index]) }
  }
  return { workspace: false, dirs: await findGoMods(dir) }
}

interface MakeTarget {
  prerequisites: string[]
  recipe: string[]
}

/** Targets and variables of a Makefile, read line by line: enough to find a target's recipe, not a make implementation. */
function parseMakefile(text: string): {
  targets: Map<string, MakeTarget>
  variables: Map<string, string>
} {
  const targets = new Map<string, MakeTarget>()
  const variables = new Map<string, string>()
  let current: MakeTarget[] = []
  for (const line of text.replace(/\\\n/g, ' ').split('\n')) {
    if (line.startsWith('\t')) {
      for (const target of current) target.recipe.push(line.trim())
      continue
    }
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const variable =
      /^(?:export\s+|override\s+)?([A-Za-z_][\w.-]*)\s*(?::{1,3}|\?|\+|!)?=\s*(.*)$/.exec(line)
    if (variable) {
      variables.set(variable[1]!, variable[2]!.trim())
      current = []
      continue
    }
    const rule = /^([^:=#]+?)\s*::?\s*([^=]*)$/.exec(line)
    if (!rule) {
      current = []
      continue
    }
    const [inline, ...rest] = rule[2]!.split(';')
    const prerequisites = (inline ?? '').trim().split(/\s+/).filter(Boolean)
    current = rule[1]!
      .trim()
      .split(/\s+/)
      .filter((name) => !name.startsWith('.'))
      .map((name) => {
        const target = targets.get(name) ?? { prerequisites: [], recipe: [] }
        target.prerequisites.push(...prerequisites)
        if (rest.length) target.recipe.push(rest.join(';').trim())
        targets.set(name, target)
        return target
      })
  }
  return { targets, variables }
}

const containerTool = /\b(docker|podman|nerdctl)\b/

/**
 * How the Makefile's `target` would run: `run` when it exists and neither its recipe, its direct
 * prerequisites' recipes nor the variables they use start a container; `container` when they do;
 * `missing` when there is no such target.
 */
export function makeTargetKind(text: string, target: string): 'run' | 'container' | 'missing' {
  const { targets, variables } = parseMakefile(text)
  const found = targets.get(target)
  if (!found) return 'missing'
  const lines = [
    ...found.recipe,
    ...found.prerequisites.flatMap((name) => targets.get(name)?.recipe ?? []),
  ]
  const expanded = lines.flatMap((line) =>
    [line].concat(
      [...line.matchAll(/\$[({]([A-Za-z_][\w.-]*)[)}]/g)].map(
        (match) => variables.get(match[1]!) ?? '',
      ),
    ),
  )
  return expanded.some((line) => containerTool.test(line)) ? 'container' : 'run'
}

const golangciConfigs = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']
const toolFiles = ['mise.toml', '.mise.toml', '.tool-versions']

async function readText(dir: string, file: string): Promise<string | undefined> {
  const handle = Bun.file(join(dir, file))
  return (await handle.exists()) ? handle.text() : undefined
}

/**
 * Environment of the Go checks: never download a toolchain (`GOTOOLCHAIN=local`), and outside a
 * `go.work` resolve modules even when `go.sum` lags (`GOFLAGS=-mod=mod`), which Go refuses in
 * workspace mode. A module that vendors keeps Go's default `-mod=vendor`, so the checks build
 * like the repository's own build and a new import fails instead of leaving `vendor/` stale.
 */
function goCheckEnv(workspace: boolean, vendored: boolean): Record<string, string> {
  return workspace || vendored
    ? { GOTOOLCHAIN: 'local' }
    : { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' }
}

/**
 * The Go checks of the repository at `dir`, empty without a Go module: `gofmt -l` over the
 * changed `.go` files, `go vet` and (unless `tests` is false) `go test`, once over a root
 * `go.work` and otherwise per module (`go -C <dir>` for nested ones), then the linter: the
 * Makefile's `lint` target, or `golangci-lint run` when a `.golangci.*` config exists and
 * `mise.toml` / `.tool-versions` provisions `golangci-lint`. A `lint` target that runs a
 * container, or a config nothing provisions, is skipped with a note.
 */
export async function detectGoChecks(
  dir: string,
  { tests = true }: { tests?: boolean } = {},
): Promise<{ checks: CheckSpec[]; notes: string[] }> {
  const { workspace, dirs } = await goModuleDirs(dir)
  if (!dirs.length) return { checks: [], notes: [] }
  const vendored = await Promise.all(
    dirs.map((module) => Bun.file(join(dir, module, 'vendor', 'modules.txt')).exists()),
  )
  const env = goCheckEnv(workspace, vendored.includes(true))
  const checks: CheckSpec[] = [{ name: GOFMT_CHECK, command: 'gofmt -l', changedGoFiles: true }]
  const notes: string[] = []
  const commands = (verb: 'vet' | 'test'): CheckSpec[] => {
    if (workspace) {
      const patterns = dirs.map((module) => (module === '.' ? './...' : `./${module}/...`))
      return [{ name: `go ${verb}`, command: `go ${verb} ${patterns.join(' ')}`, env }]
    }
    return dirs.map((module) => ({
      name: dirs.length > 1 ? `go ${verb} (${module})` : `go ${verb}`,
      command: module === '.' ? `go ${verb} ./...` : `go -C ${module} ${verb} ./...`,
      env,
    }))
  }
  checks.push(...commands('vet'), ...(tests ? commands('test') : []))

  const makefile = (await readText(dir, 'Makefile')) ?? (await readText(dir, 'GNUmakefile'))
  const lintTarget = makefile === undefined ? 'missing' : makeTargetKind(makefile, 'lint')
  const configs = await Promise.all(golangciConfigs.map((file) => readText(dir, file)))
  const config = golangciConfigs.find((_, index) => configs[index] !== undefined)
  if (lintTarget === 'run')
    return { checks: [...checks, { name: 'make lint', command: 'make lint' }], notes }
  if (lintTarget === 'container')
    notes.push('skipped `make lint`: it runs a container, which write tasks do not start')
  if (config) {
    const tools = await Promise.all(toolFiles.map((file) => readText(dir, file)))
    if (tools.some((text) => text && /golangci-lint/.test(text)))
      checks.push({ name: 'golangci-lint', command: 'golangci-lint run', env })
    else
      notes.push(
        `skipped golangci-lint: ${config} configures it, but neither a Makefile \`lint\` target nor mise.toml / .tool-versions provides it`,
      )
  }
  return { checks, notes }
}
