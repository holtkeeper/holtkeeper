import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'
import { detectPackageManager, type LockfileKind, type PackageManager } from '@holtkeeper/vuln-js'

const lockfiles: [string, LockfileKind][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** Command that installs exactly what the lockfile pins; lifecycle scripts only when allowed. */
export function frozenInstallCommand(manager: PackageManager, scripts: boolean): string[] {
  const commands: Record<PackageManager, string[]> = {
    npm: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    bun: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
    pnpm: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
    'yarn-berry': ['yarn', 'install', '--immutable'],
    'yarn-classic': ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'],
  }
  const command = commands[manager]
  return scripts ? command.filter((part) => part !== '--ignore-scripts') : command
}

/** What `installDependencies` did. */
export type InstallOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'installed'; command: string[] }
  | { status: 'failed'; command: string[]; error: string }

/**
 * Installs a JavaScript project's dependencies from its root lockfile so its test runner and
 * coverage provider exist, unless `node_modules` is already there. Never throws for a failed
 * install: tests may still run without it, and the caller decides what a missing report means.
 */
export async function installDependencies(options: {
  dir: string
  runner: CommandRunner
  /** Run lifecycle scripts (`postinstall`, ...). Default false. */
  scripts?: boolean
  signal?: AbortSignal
}): Promise<InstallOutcome> {
  const { dir, runner, signal } = options
  if (!existsSync(join(dir, 'package.json')))
    return { status: 'skipped', reason: 'no package.json' }
  if (existsSync(join(dir, 'node_modules')))
    return { status: 'skipped', reason: 'node_modules exists' }
  const found = lockfiles.find(([file]) => existsSync(join(dir, file)))
  if (!found) return { status: 'skipped', reason: 'no lockfile' }
  let manifest: unknown
  try {
    manifest = await Bun.file(join(dir, 'package.json')).json()
  } catch {
    manifest = undefined
  }
  const packageManager =
    typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest
      ? manifest.packageManager
      : undefined
  const manager = await detectPackageManager(found[1], dir, packageManager)
  const scripts = options.scripts ?? false
  const command = frozenInstallCommand(manager, scripts)
  try {
    const result = await runner.run(command, {
      cwd: dir,
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: {
        CI: 'true',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        ...(scripts ? {} : { YARN_ENABLE_SCRIPTS: 'false', npm_config_ignore_scripts: 'true' }),
      },
      ...(signal ? { signal } : {}),
    })
    if (result.exitCode === 0) return { status: 'installed', command }
    const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n')
    return { status: 'failed', command, error: `exit ${result.exitCode}: ${output}` }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      status: 'failed',
      command,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
