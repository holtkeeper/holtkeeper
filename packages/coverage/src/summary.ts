import {
  type Counts,
  type CoverageData,
  type FileCoverageData,
  percentOf,
  sumCounts,
} from './model.ts'

/** Folders that hold one workspace package per child, so a package is two segments deep. */
const workspaceFolders = new Set([
  'packages',
  'apps',
  'libs',
  'services',
  'modules',
  'plugins',
  'tools',
  'cmd',
])

/** Where files directly in the checkout root are grouped. */
export const ROOT_GROUP = '.'

/** Totals of one record: what a coverage card shows without the per-file list. */
export interface CoverageTotals {
  lines: Counts
  functions?: Counts
  branches?: Counts
  files: number
  /** Source files no test loaded. */
  untested: number
  /** Lines to cover in files no test loaded; part of `lines.total`. */
  untestedLines: number
}

/** Coverage of a package or top-level folder. */
export interface CoverageGroup {
  /** Folder path, e.g. `packages/widget` or `src`; `ROOT_GROUP` for files in the root. */
  path: string
  lines: Counts
  functions?: Counts
  branches?: Counts
  files: number
  untested: number
}

/** One file whose line coverage moved between two records, in points of percent. */
export interface CoverageFileChange {
  file: string
  /** Absent for a file the earlier record did not have. */
  before?: number
  after: number
  /** `after - before`; `after` for a new file. */
  delta: number
}

/** Line coverage of the files whose counts changed between two records. */
export interface ChangedFilesCoverage {
  /** Files that are new or whose line, branch or function counts differ. */
  files: number
  lines: Counts
}

const untested = (files: readonly FileCoverageData[]) =>
  files.filter((file) => file.loaded === false)

/** Totals of a record. */
export function coverageTotals(data: CoverageData): CoverageTotals {
  const missing = untested(data.files)
  return {
    lines: data.summary.lines,
    ...(data.summary.functions ? { functions: data.summary.functions } : {}),
    ...(data.summary.branches ? { branches: data.summary.branches } : {}),
    files: data.files.length,
    untested: missing.length,
    untestedLines: missing.reduce((sum, file) => sum + file.lines.total, 0),
  }
}

/**
 * The package or folder a file belongs to: the first segment, or the first two below a folder of
 * workspace packages (`packages/widget`). Files in the root belong to `ROOT_GROUP`.
 */
export function coverageGroupOf(file: string): string {
  const parts = file.split('/')
  if (parts.length < 2) return ROOT_GROUP
  const [first = ROOT_GROUP, second] = parts
  return workspaceFolders.has(first) && parts.length > 2 && second ? `${first}/${second}` : first
}

/** Coverage per package or top-level folder, most uncovered lines first. */
export function coverageGroups(files: readonly FileCoverageData[]): CoverageGroup[] {
  const groups = new Map<string, FileCoverageData[]>()
  for (const file of files) {
    const path = coverageGroupOf(file.file)
    groups.set(path, [...(groups.get(path) ?? []), file])
  }
  return [...groups]
    .map(([path, members]): CoverageGroup => {
      const functions = sumCounts(members.map((file) => file.functions))
      const branches = sumCounts(members.map((file) => file.branches))
      return {
        path,
        lines: sumCounts(members.map((file) => file.lines)) ?? { covered: 0, total: 0 },
        ...(functions ? { functions } : {}),
        ...(branches ? { branches } : {}),
        files: members.length,
        untested: untested(members).length,
      }
    })
    .toSorted(
      (a, b) =>
        b.lines.total - b.lines.covered - (a.lines.total - a.lines.covered) ||
        a.path.localeCompare(b.path),
    )
}

/** The `limit` files with the most uncovered lines, files without lines to cover left out. */
export function worstFiles(files: readonly FileCoverageData[], limit = 10): FileCoverageData[] {
  return files
    .filter((file) => file.lines.total > file.lines.covered)
    .toSorted(
      (a, b) =>
        b.lines.total - b.lines.covered - (a.lines.total - a.lines.covered) ||
        a.file.localeCompare(b.file),
    )
    .slice(0, limit)
}

/**
 * Files whose line coverage moved by `minPoints` or more since `previous`, largest move first.
 * New files count from zero; removed files are left out.
 */
export function coverageChanges(
  data: CoverageData,
  previous: CoverageData,
  minPoints = 5,
): CoverageFileChange[] {
  const before = new Map(previous.files.map((file) => [file.file, file]))
  return data.files
    .flatMap((file): CoverageFileChange[] => {
      const after = percentOf(file.lines)
      if (after === undefined) return []
      const old = before.get(file.file)
      if (!old) return after >= minPoints ? [{ file: file.file, after, delta: after }] : []
      const then = percentOf(old.lines)
      if (then === undefined || Math.abs(after - then) < minPoints) return []
      return [{ file: file.file, before: then, after, delta: after - then }]
    })
    .toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.file.localeCompare(b.file))
}

const sameCounts = (a: Counts | undefined, b: Counts | undefined) =>
  a?.covered === b?.covered && a?.total === b?.total

/**
 * Line coverage of the files that are new or whose counts differ since `previous`: a stand-in for
 * the coverage of what changed. `undefined` when no file with lines to cover changed.
 */
export function changedFilesCoverage(
  data: CoverageData,
  previous: CoverageData,
): ChangedFilesCoverage | undefined {
  const before = new Map(previous.files.map((file) => [file.file, file]))
  const changed = data.files.filter((file) => {
    if (file.lines.total === 0) return false
    const old = before.get(file.file)
    return (
      !old ||
      !sameCounts(old.lines, file.lines) ||
      !sameCounts(old.branches, file.branches) ||
      !sameCounts(old.functions, file.functions)
    )
  })
  const lines = sumCounts(changed.map((file) => file.lines))
  return lines ? { files: changed.length, lines } : undefined
}
