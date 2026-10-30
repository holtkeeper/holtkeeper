/** A dotted numeric version with as many parts as written: `22` → `[22]`, `1.23.4` → `[1, 23, 4]`. */
export interface Version {
  parts: number[]
  /** Text after `-` or `+`, e.g. `rc.1`. */
  pre?: string
}

/** How far a version is behind the latest one, judged only to the precision it was written with. */
export type Lag = 'current' | 'patch' | 'minor' | 'major' | 'ahead' | 'unknown'

const pattern = /^v?(\d+(?:\.\d+)*)(?:[-+]([0-9A-Za-z.+-]+))?$/

/** Parses `v1.2.3`, `22`, `3.12`, `24.04`, `1.0.0-rc.1`; `undefined` for anything else. */
export function parseVersion(text: string): Version | undefined {
  const match = pattern.exec(text.trim())
  if (!match?.[1]) return undefined
  return { parts: match[1].split('.').map(Number), ...(match[2] ? { pre: match[2] } : {}) }
}

/** Negative when `a` is older; missing parts count as 0 and then as less precise. */
export function compareVersions(a: Version, b: Version): number {
  const length = Math.max(a.parts.length, b.parts.length)
  for (let index = 0; index < length; index++) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (a.pre !== b.pre) {
    if (a.pre === undefined) return 1
    if (b.pre === undefined) return -1
    return a.pre < b.pre ? -1 : 1
  }
  return a.parts.length - b.parts.length
}

/** Compares version strings; unparsable ones sort first. */
export function compareVersionText(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b)
  return compareVersions(left, right)
}

/** Distinct versions, oldest first. */
export const sortVersions = (versions: Iterable<string>) =>
  [...new Set(versions)].toSorted(compareVersionText)

/**
 * How far `current` is behind `latest`, comparing only the parts `current` names: a floating `22`
 * is current while `latest` is any `22.x`, and `22.4` is a minor behind `22.11.0`.
 */
export function lagOf(current: string | undefined, latest: string | undefined): Lag {
  const now = current ? parseVersion(current) : undefined
  const last = latest ? parseVersion(latest) : undefined
  if (!now || !last) return 'unknown'
  for (let index = 0; index < now.parts.length; index++) {
    const diff = (now.parts[index] ?? 0) - (last.parts[index] ?? 0)
    if (diff > 0) return 'ahead'
    if (diff < 0) return index === 0 ? 'major' : index === 1 ? 'minor' : 'patch'
  }
  return 'current'
}

/** Majors between `current` and `latest`; `undefined` when either is not a version. */
export function majorsBehind(current: string | undefined, latest: string | undefined) {
  const now = current ? parseVersion(current) : undefined
  const last = latest ? parseVersion(latest) : undefined
  return now && last ? Math.max(0, (last.parts[0] ?? 0) - (now.parts[0] ?? 0)) : undefined
}

/** The major part of a version, as text; the whole value when it is not a version. */
export const majorOf = (version: string) => {
  const parsed = parseVersion(version)
  return parsed ? String(parsed.parts[0]) : version
}
