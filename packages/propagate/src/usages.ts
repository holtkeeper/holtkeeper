import { bumpRange, compareVersionText, isAtLeast, minimumOfRange } from './semver.ts'
import { yamlRecord } from './text-edit.ts'
import type { PackageTarget, Usage, UsageKind } from './types.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sections: [string, UsageKind][] = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
]

/** Whether an override or resolution key selects `name`: `name`, `name@<range>`, `**\/name`, `parent/name`. */
const selects = (key: string, name: string) =>
  key === name || key.startsWith(`${name}@`) || key.endsWith(`/${name}`) || key.endsWith(`>${name}`)

/** Fills `current`, `next` and `note` of an npm declaration for `target`. */
export function npmUsage(
  base: Omit<Usage, 'current' | 'next' | 'note' | 'ecosystem'>,
  target: PackageTarget,
): Usage {
  const usage: Usage = { ...base, ecosystem: 'npm' }
  const declared = base.declared.trim()
  if (declared.startsWith('workspace:'))
    return { ...usage, note: 'workspace package of this repository' }
  if (declared.startsWith('catalog:')) {
    const name = declared.slice('catalog:'.length) || 'default'
    return { ...usage, note: `version comes from catalog "${name}"` }
  }
  const current = minimumOfRange(declared)
  if (current === undefined)
    return { ...usage, note: `"${declared}" is not a registry version; left as is` }
  if (isAtLeast(declared, target.version)) {
    const newer = (compareVersionText(current, target.version) ?? 0) > 0
    return { ...usage, current, ...(newer ? { note: 'already newer than the target' } : {}) }
  }
  const next = bumpRange(declared, target.version)
  return next
    ? { ...usage, current, next }
    : { ...usage, current, note: 'cannot rewrite this range' }
}

function walkOverrides(
  node: Record<string, unknown>,
  path: string[],
  kind: UsageKind,
  manifest: string,
  target: PackageTarget,
  out: Usage[],
) {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && selects(key, target.name)) {
      if (value.startsWith('$')) continue
      out.push(
        npmUsage(
          { package: target.name, manifest, path: [...path, key], kind, declared: value },
          target,
        ),
      )
    } else if (isRecord(value)) {
      if (selects(key, target.name) && typeof value['.'] === 'string')
        out.push(
          npmUsage(
            {
              package: target.name,
              manifest,
              path: [...path, key, '.'],
              kind,
              declared: value['.'],
            },
            target,
          ),
        )
      walkOverrides(value, [...path, key], kind, manifest, target, out)
    }
  }
}

function catalogUsages(
  root: Record<string, unknown>,
  prefix: string[],
  manifest: string,
  target: PackageTarget,
  out: Usage[],
) {
  const catalog = root['catalog']
  if (isRecord(catalog) && typeof catalog[target.name] === 'string')
    out.push(
      npmUsage(
        {
          package: target.name,
          manifest,
          path: [...prefix, 'catalog', target.name],
          kind: 'catalog',
          declared: String(catalog[target.name]),
        },
        target,
      ),
    )
  const catalogs = root['catalogs']
  if (!isRecord(catalogs)) return
  for (const [name, entries] of Object.entries(catalogs)) {
    if (isRecord(entries) && typeof entries[target.name] === 'string')
      out.push(
        npmUsage(
          {
            package: target.name,
            manifest,
            path: [...prefix, 'catalogs', name, target.name],
            kind: 'catalog',
            declared: String(entries[target.name]),
          },
          target,
        ),
      )
  }
}

/**
 * Declarations of the npm `targets` in one `package.json`: dependency sections, npm/bun
 * `overrides`, `pnpm.overrides`, yarn `resolutions` and bun catalogs (`catalog`, `catalogs`, also
 * under `workspaces`). Throws on invalid JSON.
 */
export function packageJsonUsages(
  manifest: string,
  text: string,
  targets: PackageTarget[],
): Usage[] {
  const json: unknown = JSON.parse(text)
  if (!isRecord(json)) throw new Error(`${manifest} is not an object`)
  const out: Usage[] = []
  for (const target of targets) {
    if (target.ecosystem !== 'npm') continue
    for (const [section, kind] of sections) {
      const deps = json[section]
      if (isRecord(deps) && typeof deps[target.name] === 'string')
        out.push(
          npmUsage(
            {
              package: target.name,
              manifest,
              path: [section, target.name],
              kind,
              declared: String(deps[target.name]),
            },
            target,
          ),
        )
    }
    const overrides = json['overrides']
    if (isRecord(overrides))
      walkOverrides(overrides, ['overrides'], 'override', manifest, target, out)
    const pnpm = json['pnpm']
    if (isRecord(pnpm) && isRecord(pnpm['overrides']))
      walkOverrides(pnpm['overrides'], ['pnpm', 'overrides'], 'override', manifest, target, out)
    const resolutions = json['resolutions']
    if (isRecord(resolutions))
      walkOverrides(resolutions, ['resolutions'], 'resolution', manifest, target, out)
    catalogUsages(json, [], manifest, target, out)
    const workspaces = json['workspaces']
    if (isRecord(workspaces)) catalogUsages(workspaces, ['workspaces'], manifest, target, out)
  }
  return out
}

/** Declarations of the npm `targets` in a `pnpm-workspace.yaml`: `catalog`, `catalogs.<name>` and `overrides`. */
export function pnpmWorkspaceUsages(
  manifest: string,
  text: string,
  targets: PackageTarget[],
): Usage[] {
  const parsed: unknown = Bun.YAML.parse(text)
  if (!isRecord(parsed)) return []
  const out: Usage[] = []
  for (const target of targets) {
    if (target.ecosystem !== 'npm') continue
    const add = (path: string[], kind: UsageKind, declared: string) =>
      out.push(npmUsage({ package: target.name, manifest, path, kind, declared }, target))
    const catalog = yamlRecord(text, ['catalog'])[target.name]
    if (catalog !== undefined) add(['catalog', target.name], 'catalog', catalog)
    const catalogs = parsed['catalogs']
    if (isRecord(catalogs))
      for (const name of Object.keys(catalogs)) {
        const declared = yamlRecord(text, ['catalogs', name])[target.name]
        if (declared !== undefined) add(['catalogs', name, target.name], 'catalog', declared)
      }
    for (const [key, declared] of Object.entries(yamlRecord(text, ['overrides'])))
      if (selects(key, target.name) && !declared.startsWith('$'))
        add(['overrides', key], 'override', declared)
  }
  return out
}

/** `require` entries of a `go.mod` as `[module, version]` pairs. */
export function goRequires(text: string): [string, string][] {
  const requires: [string, string][] = []
  let block = false
  for (const raw of text.split('\n')) {
    const code = raw.replace(/\/\/.*$/, '').trim()
    if (!code) continue
    if (block) {
      if (code === ')') block = false
      else {
        const [name, version] = code.split(/\s+/)
        if (name && version) requires.push([name.replaceAll('"', ''), version])
      }
      continue
    }
    if (/^require\s*\($/.test(code)) block = true
    else if (code.startsWith('require ')) {
      const [, name, version] = code.split(/\s+/)
      if (name && version) requires.push([name.replaceAll('"', ''), version])
    }
  }
  return requires
}

/** Requirements of the Go `targets` in one `go.mod`; a requirement below the target gets `next`. */
export function goModUsages(manifest: string, text: string, targets: PackageTarget[]): Usage[] {
  const out: Usage[] = []
  const requires = goRequires(text)
  for (const target of targets) {
    if (target.ecosystem !== 'Go') continue
    for (const [name, declared] of requires) {
      if (name !== target.name) continue
      const order = compareVersionText(declared, target.version)
      const base: Usage = {
        package: name,
        ecosystem: 'Go',
        manifest,
        path: [name],
        kind: 'go',
        declared,
        current: declared,
      }
      if (order === undefined)
        out.push({ ...base, note: `cannot compare ${declared} with ${target.version}` })
      else if (order >= 0)
        out.push({ ...base, ...(order > 0 ? { note: 'already newer than the target' } : {}) })
      else out.push({ ...base, next: target.version })
    }
  }
  return out
}

/** Workspace patterns of a `package.json` (array or `{ packages }`); negations dropped. */
export function packageJsonWorkspaces(text: string): string[] {
  const json: unknown = JSON.parse(text)
  if (!isRecord(json)) return []
  const raw = json['workspaces']
  const list = isRecord(raw) ? raw['packages'] : raw
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string' && !item.startsWith('!'))
    : []
}

/** Workspace patterns of a `pnpm-workspace.yaml`; negations dropped. */
export function pnpmWorkspacePatterns(text: string): string[] {
  const parsed: unknown = Bun.YAML.parse(text)
  const list = isRecord(parsed) ? parsed['packages'] : undefined
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string' && !item.startsWith('!'))
    : []
}

/** Module directories a `go.work` uses, without `./`; `.` is the root. */
export function goWorkDirs(text: string): string[] {
  const dirs: string[] = []
  let block = false
  for (const raw of text.split('\n')) {
    const code = raw.replace(/\/\/.*$/, '').trim()
    if (!code) continue
    if (block) {
      if (code === ')') block = false
      else dirs.push(code)
      continue
    }
    if (/^use\s*\($/.test(code)) block = true
    else if (code.startsWith('use ')) dirs.push(code.slice(4).trim())
  }
  return dirs.map((dir) => dir.replaceAll('"', '').replace(/^\.\//, '').replace(/\/+$/, '') || '.')
}
