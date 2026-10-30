import type { UsageKind } from './types.ts'

/** A dependency as one manifest declares it. */
export interface Declaration {
  name: string
  declared: string
  kind: UsageKind
}

export interface PackageManifest {
  name?: string
  dependencies: Declaration[]
  /** Workspace patterns from `workspaces` (array or `{ packages }`), negations dropped. */
  workspaces: string[]
}

export interface GoModule {
  module?: string
  requires: Declaration[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const sections: [string, UsageKind][] = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
]

/** Reads a `package.json`; throws on invalid JSON. A dependency listed twice keeps its first section. */
export function parsePackageJson(text: string): PackageManifest {
  const json: unknown = JSON.parse(text)
  if (!isRecord(json)) throw new Error('package.json is not an object')
  const seen = new Set<string>()
  const dependencies: Declaration[] = []
  for (const [section, kind] of sections) {
    const entries = json[section]
    if (!isRecord(entries)) continue
    for (const [name, declared] of Object.entries(entries)) {
      if (typeof declared !== 'string' || seen.has(name)) continue
      seen.add(name)
      dependencies.push({ name, declared, kind })
    }
  }
  const raw = json['workspaces']
  const patterns = isRecord(raw) ? strings(raw['packages']) : strings(raw)
  return {
    ...(typeof json['name'] === 'string' ? { name: json['name'] } : {}),
    dependencies,
    workspaces: patterns.filter((pattern) => !pattern.startsWith('!')),
  }
}

/** Workspace patterns of a `pnpm-workspace.yaml`, negations dropped. */
export function parsePnpmWorkspace(text: string): string[] {
  const parsed: unknown = Bun.YAML.parse(text)
  return isRecord(parsed)
    ? strings(parsed['packages']).filter((pattern) => !pattern.startsWith('!'))
    : []
}

const stripComment = (line: string) => {
  const index = line.indexOf('//')
  return {
    code: (index === -1 ? line : line.slice(0, index)).trim(),
    comment: index === -1 ? '' : line.slice(index + 2),
  }
}

/** Reads `module` and `require` directives of a `go.mod`; `// indirect` requirements are kept as `indirect`. */
export function parseGoMod(text: string): GoModule {
  const requires: Declaration[] = []
  let module: string | undefined
  let block: string | undefined
  for (const raw of text.split('\n')) {
    const { code, comment } = stripComment(raw)
    if (!code) continue
    if (block) {
      if (code === ')') block = undefined
      else if (block === 'require') addRequire(code, comment)
      continue
    }
    const [directive, ...rest] = code.split(/\s+/)
    if (rest[0] === '(') block = directive
    else if (directive === 'module') module = rest[0]?.replaceAll('"', '')
    else if (directive === 'require') addRequire(rest.join(' '), comment)
  }
  return { ...(module ? { module } : {}), requires }

  function addRequire(code: string, comment: string) {
    const [name, version] = code.split(/\s+/)
    if (!name || !version) return
    requires.push({
      name: name.replaceAll('"', ''),
      declared: version,
      kind: /\bindirect\b/.test(comment) ? 'indirect' : 'prod',
    })
  }
}

/** Module directories a `go.work` uses, without `./` prefixes; `.` is the root. */
export function parseGoWork(text: string): string[] {
  const dirs: string[] = []
  let inUse = false
  for (const raw of text.split('\n')) {
    const { code } = stripComment(raw)
    if (!code) continue
    if (inUse) {
      if (code === ')') inUse = false
      else dirs.push(code)
      continue
    }
    const [directive, ...rest] = code.split(/\s+/)
    if (directive !== 'use') continue
    if (rest[0] === '(') inUse = true
    else if (rest[0]) dirs.push(rest[0])
  }
  return dirs.map(normalizeDir)
}

/** `./packages/a/` → `packages/a`; the root is `.`. */
export function normalizeDir(dir: string): string {
  const trimmed = dir.replaceAll('"', '').replace(/^\.\//, '').replace(/\/+$/, '')
  return trimmed === '' ? '.' : trimmed
}

/** `*` matches within a path segment, `**` across segments. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*'
      i++
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Whether a pattern contains glob characters. */
export const isGlob = (pattern: string) => /[*?]/.test(pattern)

/**
 * Workspace directories for `patterns`. Literal patterns are taken as they are; glob patterns can
 * only be matched against `known` directories (e.g. from a lockfile), since the forge API cannot
 * list directories. Sorted, without the root, at most `limit`.
 */
export function workspaceDirs(patterns: string[], known: string[], limit: number): string[] {
  const dirs = new Set<string>()
  for (const pattern of patterns.map(normalizeDir)) {
    if (!isGlob(pattern)) dirs.add(pattern)
    else {
      const regexp = globToRegExp(pattern)
      for (const dir of known.map(normalizeDir)) if (regexp.test(dir)) dirs.add(dir)
    }
  }
  dirs.delete('.')
  return [...dirs].toSorted().slice(0, limit)
}

/** `packages/a` + `package.json` → `packages/a/package.json`; the root dir adds nothing. */
export const joinPath = (dir: string, file: string) => (dir === '.' ? file : `${dir}/${file}`)
