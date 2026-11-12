// oxlint-disable no-await-in-loop -- checks run one after another in the same checkout
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'

import type { CheckResult } from './schema.ts'

/** Lowercase words joined by `-`, at most 40 characters; `task` when nothing is left. */
export function taskSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'task'
}

/** `holtkeeper/<task-id>-<slug>`: the branch a write task pushes, the same in every repository of a group. */
export const taskBranch = (taskId: string, title: string) =>
  `holtkeeper/${taskId}-${taskSlug(title)}`

/** A file that differs from `HEAD`; `create` covers untracked files. */
export interface ChangedFile {
  path: string
  action: 'create' | 'update' | 'delete'
}

const ignored = (path: string) => /(^|\/)node_modules\//.test(path)

/** Parses `git status --porcelain -z`; a rename is a delete of the old path and a create of the new one. */
export function parseStatus(output: string): ChangedFile[] {
  const entries = output.split('\0').filter(Boolean)
  const files: ChangedFile[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code[0] === 'R' || code[0] === 'C') {
      const original = entries[++i]
      if (code[0] === 'R' && original && !ignored(original))
        files.push({ path: original, action: 'delete' })
      if (!ignored(path)) files.push({ path, action: 'create' })
      continue
    }
    if (ignored(path)) continue
    files.push({
      path,
      action: code.includes('D')
        ? 'delete'
        : code === '??' || code[0] === 'A'
          ? 'create'
          : 'update',
    })
  }
  return files
}

/** Files changed in the checkout at `dir`, untracked ones included, `node_modules` left out. */
export async function changedFiles(dir: string, runner: CommandRunner): Promise<ChangedFile[]> {
  const { stdout } = await runChecked(
    runner,
    ['git', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: dir },
  )
  return parseStatus(stdout)
}

const PATCH_FILE = '.holtkeeper-task.patch'

/**
 * Applies `patch` with `git apply -3` (three-way merge where blobs allow it). `false` when it does
 * not apply cleanly; the checkout is then reset, so the agent starts from a clean tree.
 */
export async function applyPatch(
  dir: string,
  runner: CommandRunner,
  patch: string,
  log: (line: string) => void,
): Promise<boolean> {
  const file = join(dir, PATCH_FILE)
  await Bun.write(file, patch.endsWith('\n') ? patch : `${patch}\n`)
  try {
    const result = await runner.run(['git', 'apply', '-3', '--whitespace=nowarn', PATCH_FILE], {
      cwd: dir,
    })
    if (result.exitCode === 0) return true
    log(
      `git apply -3 failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-5).join(' | ')}`,
    )
  } finally {
    await rm(file, { force: true })
  }
  await runner.run(['git', 'reset', '--hard', '--quiet'], { cwd: dir })
  await runner.run(['git', 'clean', '-fdq'], { cwd: dir })
  return false
}

/** One check command. */
export interface CheckSpec {
  name: string
  command: string
}

type Manager = 'bun' | 'pnpm' | 'yarn' | 'npm'

const lockfiles: [string, Manager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

const installCommands: Record<Manager, string> = {
  bun: 'bun install --frozen-lockfile',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  npm: 'npm ci',
}

const scriptCandidates: [string, string[]][] = [
  ['typecheck', ['typecheck', 'type-check', 'tsc']],
  ['lint', ['lint']],
  ['format', ['format:check', 'fmt:check', 'check:format']],
  ['test', ['test']],
]

const exists = (dir: string, file: string) => Bun.file(join(dir, file)).exists()

async function managerOf(dir: string): Promise<Manager> {
  for (const [file, manager] of lockfiles) if (await exists(dir, file)) return manager
  return 'npm'
}

/**
 * The repository's own checks: `install`, then the `typecheck`, `lint`, format check and `test`
 * scripts of the root `package.json` through its package manager (from the lockfile), and
 * `go vet ./...` plus `go test ./...` for a Go module. With `tests: false` (no tests by design)
 * the `test` script and `go test` are left out. `configured` replaces the detection.
 */
export async function detectChecks(
  dir: string,
  configured?: readonly string[],
  { tests = true }: { tests?: boolean } = {},
): Promise<CheckSpec[]> {
  if (configured)
    return configured.map((command, index) => ({ name: `check ${index + 1}`, command }))
  const checks: CheckSpec[] = []
  const manifest = Bun.file(join(dir, 'package.json'))
  if (await manifest.exists()) {
    const parsed: unknown = await manifest.json()
    const scripts: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'scripts') : undefined
    const has = (name: string) =>
      typeof scripts === 'object' &&
      scripts !== null &&
      typeof Reflect.get(scripts, name) === 'string'
    const manager = await managerOf(dir)
    for (const [name, candidates] of scriptCandidates) {
      if (!tests && name === 'test') continue
      const script = candidates.find(has)
      if (script) checks.push({ name, command: `${manager} run ${script}` })
    }
    if (checks.length) checks.unshift({ name: 'install', command: installCommands[manager] })
  }
  if (await exists(dir, 'go.mod'))
    checks.push(
      { name: 'go vet', command: 'go vet ./...' },
      ...(tests ? [{ name: 'go test', command: 'go test ./...' }] : []),
    )
  return checks
}

/**
 * The only commands the agent may run in the checkout: the checks (also through `mise exec --`)
 * and read-only git.
 */
export function agentCommands(checks: readonly CheckSpec[]): string[] {
  const commands = checks.map((check) => check.command)
  return [
    ...commands,
    ...commands.map((command) => `mise exec -- ${command}`),
    'git status',
    'git diff',
    'git log',
  ]
}

const tail = (text: string, lines = 80) => {
  const kept = text.trim().split('\n').slice(-lines).join('\n')
  return kept.length > 8000 ? kept.slice(-8000) : kept
}

/** Runs `checks` in order through `runner` with `CI=1`; a failing `install` stops the rest. */
export async function runChecks(
  dir: string,
  runner: CommandRunner,
  checks: readonly CheckSpec[],
  options: { signal?: AbortSignal; env?: Record<string, string>; log: (line: string) => void },
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    const started = Date.now()
    const result = await runner.run(['sh', '-c', check.command], {
      cwd: dir,
      env: { ...options.env, CI: '1' },
      ...(options.signal && { signal: options.signal }),
    })
    const ok = result.exitCode === 0
    options.log(`${check.name}: ${ok ? 'passed' : `failed (exit ${result.exitCode})`}`)
    results.push({
      name: check.name,
      command: check.command,
      ok,
      exitCode: result.exitCode,
      output: tail([result.stdout, result.stderr].filter(Boolean).join('\n')),
      durationMs: Date.now() - started,
    })
    if (!ok && check.name === 'install') break
  }
  return results
}
