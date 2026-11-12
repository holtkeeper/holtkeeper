import type {
  ImpactLevel,
  NameCount,
  PackageUsageRepo,
  RepoRef,
  UsageKind,
  UsageSite,
} from '@holtkeeper/api'

import { repoKey } from './repo.ts'

/** How a member path reads after the export, e.g. `.reset` or `().reset`. */
export const memberLabel = (member: string) => (member.startsWith('()') ? member : `.${member}`)

/** Short words for how code uses an export. */
export const usageKindLabels: Record<UsageKind, string> = {
  call: 'call',
  new: 'new',
  jsx: 'JSX',
  member: 'member',
  type: 'type',
  extends: 'extends',
  reexport: 're-export',
  reference: 'reference',
  import: 'import only',
}

/** Words of an upgrade impact level. */
export const impactLabel: Record<ImpactLevel, string> = {
  breaking: 'Breaking',
  check: 'Needs a check',
  deprecated: 'Deprecated',
}

/** Chip tone of an upgrade impact level. */
export const impactTone: Record<ImpactLevel, 'danger' | 'warning' | 'default'> = {
  breaking: 'danger',
  check: 'warning',
  deprecated: 'default',
}

/** Snippet lines with their numbers; `focus` marks the line of the use. */
export function snippetLines(site: Pick<UsageSite, 'snippet' | 'snippetLine' | 'line'>) {
  return site.snippet.split('\n').map((text, index) => ({
    number: site.snippetLine + index,
    text,
    focus: site.snippetLine + index === site.line,
  }))
}

/** Kinds of use as `kind count` pairs, most frequent first. */
export const kindCounts = (kinds: Partial<Record<UsageKind, number>>) =>
  Object.keys(kinds)
    .filter((kind): kind is UsageKind => kind in usageKindLabels)
    .map((kind) => ({ kind, count: kinds[kind] ?? 0 }))
    .toSorted((a, b) => b.count - a.count)

/** Share of uses per name, in percent of the largest, for drawing bars. */
export const relativeCounts = (items: readonly NameCount[]) => {
  const max = Math.max(1, ...items.map((item) => item.count))
  return items.map((item) => ({ ...item, share: Math.round((item.count / max) * 100) }))
}

/** What code imports an entry point from: `widget-kit` for `.`, `widget-kit/button` for `./button`. */
export const importPath = (name: string, subpath: string) =>
  subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`

/** Exported names, re-exports left out, that no recorded use reaches; first appearance order. */
export function unusedExports(
  entries: readonly { symbols: readonly { name: string; kind: string }[] }[],
  used: Iterable<string>,
): string[] {
  const seen = new Set(used)
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.symbols.filter((symbol) => symbol.kind !== 'reexport').map((symbol) => symbol.name),
      ),
    ),
  ].filter((name) => !seen.has(name))
}

const fromRecord = (entry: PackageUsageRepo | undefined) =>
  entry
    ? {
        workspaces: entry.workspaces.filter((workspace) => workspace !== 'root'),
        uses: entry.count,
        files: entry.files,
        exports: entry.exports.length,
        analyzedAt: entry.analyzedAt,
      }
    : { workspaces: [] }

/** One repository of a library's Used by table. */
export interface ConsumerRow {
  repo: RepoRef
  groups: string[]
  /** Versions in use, from the usage record when there is one, else from the lockfile. */
  versions: string[]
  majorsBehind: number
  workspaces: string[]
  /** Absent without a usage record. */
  uses?: number
  files?: number
  exports?: number
  analyzedAt?: PackageUsageRepo['analyzedAt']
}

/**
 * Every repository using a library: those the dependency table knows, joined by repository with
 * their usage records, plus repositories only a usage record names. Most breaking releases
 * behind first, then by `forge:path`.
 */
export function consumerRows(
  usedBy: readonly { repo: RepoRef; groups: string[]; versions: string[]; majorsBehind: number }[],
  usage: readonly PackageUsageRepo[] = [],
): ConsumerRow[] {
  const records = new Map(usage.map((entry) => [repoKey(entry.repo), entry]))
  const rows: ConsumerRow[] = usedBy.map((user) => {
    const record = records.get(repoKey(user.repo))
    records.delete(repoKey(user.repo))
    return {
      repo: user.repo,
      groups: user.groups,
      versions: record?.versions.length ? record.versions : user.versions,
      majorsBehind: user.majorsBehind,
      ...fromRecord(record),
    }
  })
  for (const record of records.values())
    rows.push({
      repo: record.repo,
      groups: record.groups,
      versions: record.versions.length ? record.versions : record.ranges,
      majorsBehind: 0,
      ...fromRecord(record),
    })
  return rows.toSorted(
    (a, b) => b.majorsBehind - a.majorsBehind || repoKey(a.repo).localeCompare(repoKey(b.repo)),
  )
}
