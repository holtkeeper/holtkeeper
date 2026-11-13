import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { compareVersions } from '@holtkeeper/depgraph'

import type {
  NameCount,
  UsageEcosystem,
  UsageKind,
  UsageSite,
  UsedExport,
  UsedPackage,
} from './model.ts'

/** Caps that keep one analysis record small enough to store and send. */
export const usageLimits = {
  /** Source files read per ecosystem. */
  files: 20_000,
  /** Sites kept with a snippet per export; counts still cover every site. */
  sitesPerExport: 20,
  /** Once a package keeps this many sites, its remaining exports keep `sitesAfterBudget` each. */
  sitesPerPackage: 400,
  sitesAfterBudget: 3,
  /** Members and props listed per export. */
  names: 100,
  snippetLines: 2,
  lineLength: 200,
}

export interface RawSite {
  file: string
  offset: number
  /** Position of the site when the scanner already knows it; else derived from `offset`. */
  at?: { line: number; column: number }
  package: string
  subpath: string
  export: string
  kind: UsageKind
  member?: string
  props?: string[]
  spread?: boolean
  typed?: boolean
}

export type Positions = (offset: number) => { line: number; column: number }

export function lineIndex(text: string): Positions {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset: number) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
  }
}

/** Lines around `line` (1-based) with their common indentation removed. */
export function snippetOf(
  lines: readonly string[],
  line: number,
  around = usageLimits.snippetLines,
) {
  const first = Math.max(1, line - around)
  const last = Math.min(lines.length, line + around)
  const picked = lines.slice(first - 1, last).map((text) => {
    const trimmed = text.replace(/\s+$/, '')
    return trimmed.length > usageLimits.lineLength
      ? `${trimmed.slice(0, usageLimits.lineLength)}…`
      : trimmed
  })
  const indent = Math.min(
    ...picked.filter((text) => text.trim()).map((text) => /^[ \t]*/.exec(text)?.[0].length ?? 0),
  )
  const strip = Number.isFinite(indent) ? indent : 0
  return { snippet: picked.map((text) => text.slice(strip)).join('\n'), snippetLine: first }
}

const ranked = (counts: Map<string, number>): NameCount[] =>
  [...counts]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, usageLimits.names)

const inFile = (a: RawSite, b: RawSite) =>
  a.at && b.at ? a.at.line - b.at.line || a.at.column - b.at.column : a.offset - b.offset

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

interface GroupInput {
  dir: string
  raw: RawSite[]
  positions: Map<string, Positions>
  /** Workspace (npm) or owning module (Go) of each file. */
  owners: Map<string, string>
  /** Declared range (npm) or required version (Go) per package and owner. */
  declared: Map<string, Map<string, string>>
  /** Resolved version per package and owner. */
  versions: Map<string, Map<string, string>>
  local: Set<string>
  /** Local packages reached only through a directory `replace` (Go). */
  replaced?: Set<string>
  localVersions: Map<string, string>
  ecosystem?: UsageEcosystem
}

export async function group(input: GroupInput): Promise<UsedPackage[]> {
  const byPackage = new Map<string, Map<string, RawSite[]>>()
  for (const site of input.raw) {
    const exports =
      byPackage.get(site.package) ?? byPackage.set(site.package, new Map()).get(site.package)
    const key = `${site.subpath}\0${site.export}`
    const list = exports?.get(key)
    if (list) list.push(site)
    else exports?.set(key, [site])
  }

  const lines = new Map<string, string[]>()
  const linesOf = async (file: string) => {
    const cached = lines.get(file)
    if (cached) return cached
    const text = await readFile(join(input.dir, file), 'utf8').catch(() => '')
    const split = text.split('\n')
    lines.set(file, split)
    return split
  }

  const packages: UsedPackage[] = []
  for (const [name, exports] of byPackage) {
    const workspaces = new Set<string>()
    const packageFiles = new Set<string>()
    const used: UsedExport[] = []
    let count = 0
    let keptInPackage = 0
    const byCount = [...exports.values()].toSorted((a, b) => b.length - a.length)
    for (const sites of byCount) {
      const ordered = sites.toSorted((a, b) => a.file.localeCompare(b.file) || inFile(a, b))
      const first = ordered[0]
      if (!first) continue
      const kinds: Partial<Record<UsageKind, number>> = {}
      const members = new Map<string, number>()
      const props = new Map<string, number>()
      const files = new Set<string>()
      let spread = 0
      for (const site of ordered) {
        kinds[site.kind] = (kinds[site.kind] ?? 0) + 1
        if (site.member) bump(members, site.member)
        for (const prop of site.props ?? []) bump(props, prop)
        if (site.spread) spread += 1
        files.add(site.file)
        packageFiles.add(site.file)
        workspaces.add(input.owners.get(site.file) ?? 'root')
      }
      const kept: UsageSite[] = []
      const budget =
        keptInPackage < usageLimits.sitesPerPackage
          ? usageLimits.sitesPerExport
          : usageLimits.sitesAfterBudget
      for (const site of ordered.slice(0, budget)) {
        const at = site.at ??
          input.positions.get(site.file)?.(site.offset) ?? { line: 1, column: 1 }
        // oxlint-disable-next-line no-await-in-loop -- files are cached after the first read
        const snippet = snippetOf(await linesOf(site.file), at.line)
        kept.push({
          file: site.file,
          line: at.line,
          column: at.column,
          kind: site.kind,
          ...(site.member ? { member: site.member } : {}),
          ...(site.props?.length ? { props: site.props } : {}),
          ...(site.spread ? { spread: true } : {}),
          ...(site.typed ? { typed: true } : {}),
          ...snippet,
        })
      }
      count += ordered.length
      keptInPackage += kept.length
      used.push({
        name: first.export,
        subpath: first.subpath,
        count: ordered.length,
        files: files.size,
        kinds,
        members: ranked(members),
        props: ranked(props),
        spread,
        sites: kept,
        ...(ordered.length > kept.length ? { truncated: ordered.length - kept.length } : {}),
      })
    }
    const resolved = new Set<string>()
    const ranges = new Set<string>()
    for (const workspace of workspaces) {
      const version = input.versions.get(name)?.get(workspace)
      if (version) resolved.add(version)
      const range = input.declared.get(name)?.get(workspace)
      if (range) ranges.add(range)
    }
    if (!resolved.size)
      for (const version of input.versions.get(name)?.values() ?? []) resolved.add(version)
    const own = input.localVersions.get(name)
    if (!resolved.size && own) resolved.add(own)
    if (!ranges.size)
      for (const range of input.declared.get(name)?.values() ?? []) ranges.add(range)
    packages.push({
      name,
      ...(input.ecosystem && input.ecosystem !== 'npm' ? { ecosystem: input.ecosystem } : {}),
      versions: [...resolved].toSorted((a, b) => compareVersions(b, a)),
      ranges: [...ranges].toSorted(),
      workspaces: [...workspaces].toSorted(),
      ...(input.local.has(name) ? { local: true } : {}),
      ...(input.replaced?.has(name) ? { replaced: true as const } : {}),
      count,
      files: packageFiles.size,
      exports: used.toSorted(
        (a, b) =>
          b.count - a.count || a.name.localeCompare(b.name) || a.subpath.localeCompare(b.subpath),
      ),
    })
  }
  return packages
}

export const byUses = (a: UsedPackage, b: UsedPackage) =>
  b.count - a.count || a.name.localeCompare(b.name)
