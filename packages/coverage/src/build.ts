import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'

const BUILD_TIMEOUT_MS = 10 * 60 * 1000

const runCommands: [string, string[]][] = [
  ['bun.lock', ['bun', 'run', 'build']],
  ['bun.lockb', ['bun', 'run', 'build']],
  ['pnpm-lock.yaml', ['pnpm', 'run', 'build']],
  ['yarn.lock', ['yarn', 'run', 'build']],
]

/** A workspace package whose declared entry files are missing. */
export interface UnbuiltWorkspace {
  name: string
  /** Relative to the project root. */
  dir: string
  /** Declared entry files (`main`, `module`, `types`, `typings`) that do not exist. */
  missing: string[]
}

/** What `buildWorkspaces` did. */
export type BuildOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'built'; workspaces: string[] }
  | { status: 'failed'; workspaces: string[]; error: string }

type Manifest = Record<string, unknown>

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    const json: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof json === 'object' && json !== null ? { ...json } : undefined
  } catch {
    return undefined
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []

async function workspacePatterns(dir: string, root: Manifest): Promise<string[]> {
  const field = root['workspaces']
  const patterns =
    typeof field === 'object' && field !== null && !Array.isArray(field) && 'packages' in field
      ? strings(field.packages)
      : strings(field)
  try {
    const parsed: unknown = Bun.YAML.parse(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'packages' in parsed)
      patterns.push(...strings(parsed.packages))
  } catch {
    // no pnpm workspace file
  }
  return patterns.filter((pattern) => !pattern.startsWith('!'))
}

const hasBuildScript = (manifest: Manifest) => {
  const scripts = manifest['scripts']
  return typeof scripts === 'object' && scripts !== null && 'build' in scripts
}

const dependencyNames = (manifest: Manifest) =>
  ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
    const value = manifest[field]
    return typeof value === 'object' && value !== null ? Object.keys(value) : []
  })

/**
 * Workspace packages of the project whose `main`, `module`, `types` or `typings` file is missing
 * and that have a `build` script, ordered so a package comes after the unbuilt packages it
 * depends on. Empty for projects without workspaces.
 */
export async function unbuiltWorkspaces(dir: string): Promise<UnbuiltWorkspace[]> {
  const root = await readManifest(join(dir, 'package.json'))
  if (!root) return []
  const found = new Map<string, UnbuiltWorkspace & { deps: string[] }>()
  for (const pattern of await workspacePatterns(dir, root)) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, '')}/package.json`)
    for await (const path of glob.scan({ cwd: dir })) {
      if (path.includes('node_modules/')) continue
      const manifest = await readManifest(join(dir, path))
      const name = manifest?.['name']
      if (!manifest || typeof name !== 'string' || found.has(name) || !hasBuildScript(manifest))
        continue
      const wsDir = path.slice(0, -'/package.json'.length)
      const missing = ['main', 'module', 'types', 'typings']
        .map((field) => manifest[field])
        .filter((entry): entry is string => typeof entry === 'string')
        .filter((entry) => !existsSync(join(dir, wsDir, entry)))
      if (missing.length)
        found.set(name, { name, dir: wsDir, missing, deps: dependencyNames(manifest) })
    }
  }

  const ordered: UnbuiltWorkspace[] = []
  const visiting = new Set<string>()
  const visit = (name: string) => {
    const workspace = found.get(name)
    if (!workspace || visiting.has(name)) return
    visiting.add(name)
    for (const dep of workspace.deps) visit(dep)
    if (!ordered.some((item) => item.name === name))
      ordered.push({ name, dir: workspace.dir, missing: workspace.missing })
  }
  for (const name of [...found.keys()].toSorted()) visit(name)
  return ordered
}

/**
 * Runs the `build` script of every workspace package whose entry files are missing, so tests that
 * import sibling packages resolve them. Stops at the first failing build and never throws for it:
 * the caller decides what missing coverage means.
 */
export async function buildWorkspaces(options: {
  dir: string
  runner: CommandRunner
  signal?: AbortSignal
}): Promise<BuildOutcome> {
  const { dir, runner, signal } = options
  const workspaces = await unbuiltWorkspaces(dir)
  if (!workspaces.length) return { status: 'skipped', reason: 'nothing to build' }
  const command = runCommands.find(([file]) => existsSync(join(dir, file)))?.[1] ?? [
    'npm',
    'run',
    'build',
  ]
  const built: string[] = []
  for (const workspace of workspaces) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const result = await runner.run(command, {
        cwd: join(dir, workspace.dir),
        timeoutMs: BUILD_TIMEOUT_MS,
        env: { CI: 'true' },
        ...(signal ? { signal } : {}),
      })
      if (result.exitCode !== 0) {
        const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n')
        return {
          status: 'failed',
          workspaces: built,
          error: `${workspace.name}: exit ${result.exitCode}: ${output}`,
        }
      }
    } catch (error) {
      signal?.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'failed', workspaces: built, error: `${workspace.name}: ${message}` }
    }
    built.push(workspace.name)
  }
  return { status: 'built', workspaces: built }
}
