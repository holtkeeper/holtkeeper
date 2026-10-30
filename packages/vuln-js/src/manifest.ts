import type { Finding } from '@holtkeeper/vuln'

import { type PackageManager, supportsVersionSelectors } from './manager.ts'

/** A parsed `package.json`; only the fields the fixer touches are typed. */
export type Manifest = Record<string, unknown>

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** Outcome of planning manifest edits. `manifest` is a new object; the input is never mutated. */
export interface ManifestPlan {
  manifest: Manifest
  /** Whether `manifest` differs from the input. */
  changed: boolean
  /** Ids of findings whose package got a new range or override. */
  fixed: string[]
  notes: string[]
}

interface Group {
  name: string
  target: string
  lowestVulnerable: string
  findings: Finding[]
}

/** Whether `value` is a plain JSON object. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const compare = (a: string, b: string) => {
  try {
    return Bun.semver.order(a, b)
  } catch {
    return undefined
  }
}

const major = (version: string) => version.replace(/^v/, '').split('.')[0] ?? version

/** Whether `range` is a plain semver range rather than a tag, alias, path, URL or protocol. */
const isSemverRange = (range: string) =>
  !/^[a-z][a-z+-]*:/i.test(range) && !range.includes('/') && !/^[a-z]/i.test(range.trim())

const admits = (range: string, version: string) => {
  try {
    return Bun.semver.satisfies(version, range)
  } catch {
    return false
  }
}

/** Where overrides live in `package.json` for the given manager, as a key path. */
const overridesPath = (manager: PackageManager): readonly string[] =>
  manager === 'pnpm'
    ? ['pnpm', 'overrides']
    : manager === 'npm' || manager === 'bun'
      ? ['overrides']
      : ['resolutions']

const overrideKey = (manager: PackageManager, group: Group) =>
  supportsVersionSelectors(manager)
    ? `${group.name}@>=${group.lowestVulnerable} <${group.target}`
    : group.name

function groupFindings(findings: readonly Finding[], manager: PackageManager, notes: string[]) {
  const groups = new Map<string, Group>()
  for (const finding of findings) {
    const { name, version } = finding.package
    if (finding.package.ecosystem !== 'npm') {
      notes.push(`${finding.id}: ${name} is not an npm package; skipped`)
      continue
    }
    const target = finding.fixedVersions[0]
    if (!target) {
      notes.push(`${finding.id}: no fixed version of ${name}@${version} is known; skipped`)
      continue
    }
    const order = compare(target, version)
    if (order === undefined) {
      notes.push(`${finding.id}: cannot compare ${name} versions ${version} and ${target}; skipped`)
      continue
    }
    if (order <= 0) {
      notes.push(`${finding.id}: fix ${target} is not newer than ${name}@${version}; skipped`)
      continue
    }
    // With selector keys each major line gets its own override, so one advisory on an old
    // line does not drag other lines forward; without them one override has to cover all.
    const key = supportsVersionSelectors(manager) ? `${name}\u0000${major(version)}` : name
    const group = groups.get(key)
    if (!group) {
      groups.set(key, { name, target, lowestVulnerable: version, findings: [finding] })
      continue
    }
    group.findings.push(finding)
    if ((compare(target, group.target) ?? 0) > 0) group.target = target
    if ((compare(version, group.lowestVulnerable) ?? 0) < 0) group.lowestVulnerable = version
  }
  return [...groups.values()]
}

function lookup(root: Manifest, path: readonly string[]): Record<string, unknown> {
  let current: unknown = root
  for (const key of path) current = isRecord(current) ? current[key] : undefined
  return isRecord(current) ? current : {}
}

function ensureObject(root: Manifest, path: readonly string[]): Record<string, unknown> {
  let current: Record<string, unknown> = root
  for (const key of path) {
    const next = current[key]
    if (isRecord(next)) {
      current = next
    } else {
      const created: Record<string, unknown> = {}
      current[key] = created
      current = created
    }
  }
  return current
}

/**
 * Plans `package.json` edits that move vulnerable packages to their lowest fixed version: direct
 * dependencies whose range still admits the vulnerable version get `^<target>`, transitive ones
 * get an override in the manager's format. Several findings for the same package resolve to the
 * highest target; nothing is ever downgraded. Findings it cannot handle are explained in `notes`.
 */
export function planManifestEdits(
  input: Manifest,
  findings: readonly Finding[],
  manager: PackageManager,
): ManifestPlan {
  const manifest = structuredClone(input)
  const notes: string[] = []
  const fixed: string[] = []
  let changed = false

  for (const group of groupFindings(findings, manager, notes)) {
    const ids = group.findings.map((finding) => finding.id)
    const label = `${ids.join(', ')}: ${group.name}`
    const desired = `^${group.target}`

    const direct = dependencySections.flatMap((section) => {
      const deps = manifest[section]
      const range = isRecord(deps) ? deps[group.name] : undefined
      return typeof range === 'string' && isRecord(deps) ? [{ deps, range }] : []
    })

    if (direct.length > 0) {
      const vulnerable = group.findings.map((finding) => finding.package.version)
      let bumped = false
      let unsupported = false
      for (const { deps, range } of direct) {
        if (!isSemverRange(range)) {
          notes.push(`${label} uses range "${range}", which is not a semver range; skipped`)
          unsupported = true
          continue
        }
        if (!vulnerable.some((version) => admits(range, version))) continue
        deps[group.name] = desired
        bumped = true
      }
      if (bumped) {
        changed = true
        fixed.push(...ids)
      } else if (!unsupported) {
        notes.push(
          `${label} is a direct dependency whose range already excludes the vulnerable version; ` +
            'the vulnerable copy is transitive and is not overridden to avoid conflicting with it',
        )
      }
      continue
    }

    const overrides = lookup(manifest, overridesPath(manager))
    const key = overrideKey(manager, group)
    const existingKey = key in overrides ? key : group.name in overrides ? group.name : undefined
    const existing = existingKey === undefined ? undefined : overrides[existingKey]
    if (existingKey !== undefined) {
      if (typeof existing !== 'string' || !isSemverRange(existing)) {
        notes.push(`${label} already has a non-version override "${existingKey}"; skipped`)
        continue
      }
      const stillVulnerable = group.findings.some((finding) =>
        admits(existing, finding.package.version),
      )
      if (!stillVulnerable) {
        notes.push(`${label} already has override "${existingKey}": "${existing}"; left as is`)
        continue
      }
    }
    ensureObject(manifest, overridesPath(manager))[existingKey ?? key] = desired
    changed = true
    fixed.push(...ids)
  }

  return { manifest: changed ? manifest : input, changed, fixed, notes }
}

/** Serializes `manifest` with the indentation and line ending style of `original`. */
export function formatManifest(original: string, manifest: Manifest): string {
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0] ?? '  '
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const body = JSON.stringify(manifest, null, indent).replaceAll('\n', eol)
  return /\r?\n$/.test(original) ? body + eol : body
}
