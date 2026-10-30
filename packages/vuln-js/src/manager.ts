import { basename, join } from 'node:path'

/** JavaScript package managers the fixer knows how to drive. */
export type PackageManager = 'npm' | 'bun' | 'pnpm' | 'yarn-classic' | 'yarn-berry'

/** Lockfile family, before telling yarn classic and berry apart. */
export type LockfileKind = 'npm' | 'bun' | 'pnpm' | 'yarn'

const lockfiles: Record<string, LockfileKind> = {
  'package-lock.json': 'npm',
  'bun.lock': 'bun',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
}

/** The lockfile family of `source` by its basename, or `undefined` when it is not a JS lockfile. */
export const lockfileKind = (source: string): LockfileKind | undefined =>
  lockfiles[basename(source)]

/**
 * Tells yarn berry (2+) from classic: berry when `.yarnrc.yml` sits in the project directory or
 * `packageManager` names `yarn@2` or later. Only the project directory itself is inspected.
 */
async function isYarnBerry(projectDir: string, packageManagerField: unknown) {
  if (typeof packageManagerField === 'string') {
    const match = /^yarn@(\d+)/.exec(packageManagerField)
    if (match) return Number(match[1]) >= 2
  }
  return Bun.file(join(projectDir, '.yarnrc.yml')).exists()
}

/** Resolves the package manager for a lockfile of the given kind in `projectDir`. */
export async function detectPackageManager(
  kind: LockfileKind,
  projectDir: string,
  packageManagerField?: unknown,
): Promise<PackageManager> {
  if (kind !== 'yarn') return kind
  return (await isYarnBerry(projectDir, packageManagerField)) ? 'yarn-berry' : 'yarn-classic'
}

/** Whether the manager accepts `name@range` override keys that only match some versions. */
export const supportsVersionSelectors = (manager: PackageManager) =>
  manager === 'npm' || manager === 'bun' || manager === 'pnpm'

const updateCommands: Record<PackageManager, readonly string[]> = {
  npm: ['npm', 'install', '--package-lock-only', '--ignore-scripts'],
  bun: ['bun', 'install', '--lockfile-only', '--ignore-scripts'],
  pnpm: ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'],
  'yarn-berry': ['yarn', 'install', '--mode=update-lockfile'],
  'yarn-classic': ['yarn', 'install', '--ignore-scripts'],
}

/**
 * Command that rewrites the lockfile from `package.json` without running lifecycle scripts.
 * Every manager except yarn classic also skips populating `node_modules`.
 */
export const lockfileUpdateCommand = (manager: PackageManager): string[] => [
  ...updateCommands[manager],
]
