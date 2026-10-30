// oxlint-disable no-await-in-loop -- steps touch the same checkout or forge branch and run in order
import { dirname, join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'
import {
  type PackageManager,
  detectPackageManager,
  lockfileUpdateCommand,
} from '@holtkeeper/vuln-js'

import { setJsonString, setYamlScalar } from './text-edit.ts'
import type { Bump, Bumper, Usage } from './types.ts'

const lockfiles: [string, 'npm' | 'bun' | 'pnpm' | 'yarn'][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

/** The JavaScript project at `dir`: its package manager and lockfile, if any. */
export interface NodeProject {
  manager: PackageManager
  lockfile?: string
  scripts: Record<string, string>
}

/** Detects the package manager from the lockfile (else `packageManager`, else npm); `undefined` without `package.json`. */
export async function detectNodeProject(dir: string): Promise<NodeProject | undefined> {
  const manifest = Bun.file(join(dir, 'package.json'))
  if (!(await manifest.exists())) return undefined
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = await manifest.json()
    if (typeof parsed === 'object' && parsed !== null) json = { ...parsed }
  } catch {
    json = {}
  }
  const scripts = Object.fromEntries(
    Object.entries(
      typeof json['scripts'] === 'object' && json['scripts'] !== null ? json['scripts'] : {},
    ).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  for (const [file, kind] of lockfiles) {
    if (await Bun.file(join(dir, file)).exists())
      return {
        manager: await detectPackageManager(kind, dir, json['packageManager']),
        lockfile: file,
        scripts,
      }
  }
  const declared =
    typeof json['packageManager'] === 'string'
      ? /^(\w+)@/.exec(json['packageManager'])?.[1]
      : undefined
  const kind = declared === 'bun' || declared === 'pnpm' || declared === 'yarn' ? declared : 'npm'
  return { manager: await detectPackageManager(kind, dir, json['packageManager']), scripts }
}

/** Environment that keeps package managers from prompting and, unless allowed, from running scripts. */
export const managerEnv = (allowInstallScripts: boolean): Record<string, string> => ({
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  ...(allowInstallScripts
    ? {}
    : { YARN_ENABLE_SCRIPTS: 'false', npm_config_ignore_scripts: 'true' }),
})

const withScripts = (command: string[], allow: boolean) =>
  allow ? command.filter((part) => part !== '--ignore-scripts') : command

/** Command that installs `node_modules` from the lockfile; lifecycle scripts only when allowed. */
export function installCommand(manager: PackageManager, allowInstallScripts: boolean): string[] {
  const commands: Record<PackageManager, string[]> = {
    npm: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
    bun: ['bun', 'install', '--ignore-scripts'],
    pnpm: ['pnpm', 'install', '--ignore-scripts'],
    'yarn-berry': ['yarn', 'install'],
    'yarn-classic': ['yarn', 'install', '--ignore-scripts'],
  }
  return withScripts(commands[manager], allowInstallScripts)
}

/**
 * Applies the planned `next` values of `usages` to manifest texts, keeping all other bytes.
 * Returns the new texts by manifest and the bumps made; usages whose value cannot be located are
 * reported in `notes`.
 */
export function applyUsages(
  texts: Record<string, string>,
  usages: Usage[],
): { texts: Record<string, string>; bumps: Bump[]; notes: string[] } {
  const result = { ...texts }
  const bumps: Bump[] = []
  const notes: string[] = []
  for (const usage of usages) {
    if (usage.next === undefined || usage.ecosystem !== 'npm') continue
    const text = result[usage.manifest]
    if (text === undefined) {
      notes.push(`${usage.manifest} not found`)
      continue
    }
    const edited =
      usage.manifest.endsWith('.yaml') || usage.manifest.endsWith('.yml')
        ? setYamlScalar(text, usage.path, usage.next)
        : setJsonString(text, usage.path, usage.next)
    if (edited === undefined) {
      notes.push(`${usage.manifest}: cannot locate ${usage.path.join('.')}`)
      continue
    }
    result[usage.manifest] = edited
    bumps.push({
      package: usage.package,
      from: usage.declared,
      to: usage.next,
      manifest: usage.manifest,
    })
  }
  return { texts: result, bumps, notes }
}

/** Reads, edits and writes the manifests named by `usages` in `dir`. */
export async function writeUsages(dir: string, usages: Usage[]) {
  const texts: Record<string, string> = {}
  for (const manifest of new Set(usages.map((usage) => usage.manifest)))
    texts[manifest] = await Bun.file(join(dir, manifest)).text()
  const applied = applyUsages(texts, usages)
  for (const [manifest, text] of Object.entries(applied.texts))
    if (text !== texts[manifest]) await Bun.write(join(dir, manifest), text)
  return applied
}

/** Regenerates the lockfile of `dir` with its package manager; nothing when there is none. */
export async function regenerateLockfile(
  dir: string,
  runner: CommandRunner,
  allowInstallScripts: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const project = await detectNodeProject(dir)
  if (!project?.lockfile) return undefined
  await runChecked(
    runner,
    withScripts(lockfileUpdateCommand(project.manager), allowInstallScripts),
    {
      cwd: dir,
      env: managerEnv(allowInstallScripts),
      ...(signal ? { signal } : {}),
    },
  )
  return project.lockfile
}

/** Edits `package.json` files and `pnpm-workspace.yaml` in place, then regenerates the lockfile. */
export const npmBumper: Bumper = {
  ecosystem: 'npm',
  async bump({ dir, usages, runner, allowInstallScripts, signal }) {
    const selected = usages.filter((usage) => usage.ecosystem === 'npm' && usage.next !== undefined)
    if (selected.length === 0) return { bumps: [], notes: [] }
    const { bumps, notes } = await writeUsages(dir, selected)
    if (bumps.length === 0) return { bumps, notes }
    const lockfile = await regenerateLockfile(dir, runner, allowInstallScripts, signal)
    if (!lockfile) notes.push('no lockfile found; only manifests were changed')
    return { bumps, notes }
  },
}

/** Runs `go get <module>@<version>` and `go mod tidy` in each module, with `GOTOOLCHAIN=local`. */
export const goBumper: Bumper = {
  ecosystem: 'Go',
  async bump({ dir, usages, runner, signal }) {
    const bumps: Bump[] = []
    const selected = usages.filter((usage) => usage.ecosystem === 'Go' && usage.next !== undefined)
    const env = { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' }
    for (const [manifest, group] of Map.groupBy(selected, (usage) => usage.manifest)) {
      const cwd = join(dir, dirname(manifest))
      const options = { cwd, env, ...(signal ? { signal } : {}) }
      for (const usage of group) {
        await runChecked(runner, ['go', 'get', `${usage.package}@${usage.next}`], options)
        bumps.push({ package: usage.package, from: usage.declared, to: usage.next!, manifest })
      }
      await runChecked(runner, ['go', 'mod', 'tidy'], options)
    }
    return { bumps, notes: [] }
  },
}

/** The default bumper of each ecosystem. */
export const defaultBumpers: Bumper[] = [npmBumper, goBumper]
