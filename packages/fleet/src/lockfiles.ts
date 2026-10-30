/**
 * Resolved versions read from one lockfile. Readers only answer "which version does this
 * workspace get for this direct dependency" — they do not build a graph.
 */
export interface Lockfile {
  file: string
  /** Workspace directories the lockfile knows, `.` for the root. */
  importers: string[]
  /** Version installed for `name` in workspace `dir`, when the lockfile pins one. */
  resolve(dir: string, name: string): string | undefined
}

/** Lockfiles tried in this order; the first one present is read. */
export const lockfileNames = ['bun.lock', 'package-lock.json', 'pnpm-lock.yaml'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const dirOf = (key: string) => (key === '' || key === '.' ? '.' : key.replace(/^\.\//, ''))

/** Reads a text `bun.lock` (JSONC). Workspace-specific entries (`<workspace name>/<dep>`) win over hoisted ones. */
export function parseBunLock(text: string): Lockfile {
  const json: unknown = Bun.JSONC.parse(text)
  const workspaces = isRecord(json) && isRecord(json['workspaces']) ? json['workspaces'] : {}
  const packages = isRecord(json) && isRecord(json['packages']) ? json['packages'] : {}
  const nameOf = new Map<string, string>()
  for (const [key, value] of Object.entries(workspaces)) {
    if (isRecord(value) && typeof value['name'] === 'string') nameOf.set(dirOf(key), value['name'])
  }
  const versionAt = (key: string) => {
    const entry = packages[key]
    const id = Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : undefined
    if (!id) return undefined
    const version = id.slice(id.lastIndexOf('@') + 1)
    return /^\d/.test(version) ? version : undefined
  }
  return {
    file: 'bun.lock',
    importers: Object.keys(workspaces).map(dirOf),
    resolve(dir, name) {
      const workspace = nameOf.get(dir)
      return (
        (workspace && dir !== '.' ? versionAt(`${workspace}/${name}`) : undefined) ??
        versionAt(name)
      )
    },
  }
}

/** Reads `package-lock.json` v2/v3 (`packages` keyed by install path). */
export function parsePackageLock(text: string): Lockfile {
  const json: unknown = JSON.parse(text)
  const packages = isRecord(json) && isRecord(json['packages']) ? json['packages'] : {}
  const versionAt = (key: string) => {
    const entry = packages[key]
    return isRecord(entry) && typeof entry['version'] === 'string' && !entry['link']
      ? entry['version']
      : undefined
  }
  return {
    file: 'package-lock.json',
    importers: Object.keys(packages)
      .filter((key) => !key.includes('node_modules/'))
      .map(dirOf),
    resolve(dir, name) {
      const nested = dir === '.' ? undefined : versionAt(`${dir}/node_modules/${name}`)
      return nested ?? versionAt(`node_modules/${name}`)
    },
  }
}

/** Reads `pnpm-lock.yaml` v6+ (`importers` with `{ specifier, version }` or plain versions). */
export function parsePnpmLock(text: string): Lockfile {
  const yaml: unknown = Bun.YAML.parse(text)
  const importers = isRecord(yaml) && isRecord(yaml['importers']) ? yaml['importers'] : {}
  const byDir = new Map(Object.entries(importers).map(([key, value]) => [dirOf(key), value]))
  return {
    file: 'pnpm-lock.yaml',
    importers: [...byDir.keys()],
    resolve(dir, name) {
      const importer = byDir.get(dir)
      if (!isRecord(importer)) return undefined
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const deps = importer[section]
        if (!isRecord(deps)) continue
        const entry = deps[name]
        const raw = isRecord(entry) ? entry['version'] : entry
        if (typeof raw !== 'string') continue
        const version = raw.split('(')[0]?.trim()
        return version && /^\d/.test(version) ? version : undefined
      }
      return undefined
    },
  }
}

/** Parses a lockfile by its file name. */
export function parseLockfile(file: (typeof lockfileNames)[number], text: string): Lockfile {
  if (file === 'bun.lock') return parseBunLock(text)
  if (file === 'package-lock.json') return parsePackageLock(text)
  return parsePnpmLock(text)
}
