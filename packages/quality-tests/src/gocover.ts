import type { CoverageReport, FileCoverage, FunctionHit } from './types.ts'

/** A Go module in the analyzed directory: its import path and folder (`''` for the root). */
export interface GoModule {
  path: string
  dir: string
}

/** Maps a Go import path of a file to a path relative to the analyzed directory. */
export function goFilePath(importPath: string, modules: readonly GoModule[]): string {
  const sorted = [...modules].toSorted((a, b) => b.path.length - a.path.length)
  for (const module of sorted) {
    if (importPath.startsWith(`${module.path}/`)) {
      const rest = importPath.slice(module.path.length + 1)
      return module.dir ? `${module.dir}/${rest}` : rest
    }
  }
  return importPath
}

/**
 * Parses a Go cover profile (`go test -coverprofile`). Every block's count is spread over the
 * lines it spans (a line covered by several blocks keeps the highest count). The summary's
 * `lines` counts statements, matching the percentage `go test -cover` prints.
 */
export function parseGoCoverProfile(
  text: string,
  modules: readonly GoModule[] = [],
): CoverageReport {
  const byFile = new Map<string, Map<number, number>>()
  const statements = new Map<string, { covered: number; total: number }>()
  const block = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('mode:')) continue
    const match = block.exec(line)
    if (!match) continue
    const [, importPath = '', start, end, stmts, count] = match
    const file = goFilePath(importPath, modules)
    const hits = Number(count)
    let lines = byFile.get(file)
    if (!lines) byFile.set(file, (lines = new Map()))
    for (let n = Number(start); n <= Number(end); n++)
      lines.set(n, Math.max(lines.get(n) ?? 0, hits))
    // The same block appears once per test binary that compiled it; keep it counted once.
    const key = `${file}:${start}:${end}:${stmts}`
    const previous = statements.get(key)
    statements.set(key, {
      covered: Math.max(previous?.covered ?? 0, hits > 0 ? Number(stmts) : 0),
      total: Number(stmts),
    })
  }

  const files: FileCoverage[] = [...byFile].map(([file, lines]) => ({
    file,
    lines: [...lines].map(([line, hits]) => ({ line, hits })).toSorted((a, b) => a.line - b.line),
    functions: [],
    branches: [],
  }))
  let covered = 0
  let total = 0
  for (const counts of statements.values()) {
    covered += counts.covered
    total += counts.total
  }
  return { format: 'go', languages: ['go'], files, summary: { lines: { covered, total } } }
}

/**
 * Parses `go tool cover -func` output into functions per file. Only "covered at all or not" is
 * known from it: `hits` is 1 for a function above 0% and 0 otherwise.
 */
export function parseGoCoverFunc(
  text: string,
  modules: readonly GoModule[] = [],
): Map<string, FunctionHit[]> {
  const result = new Map<string, FunctionHit[]>()
  const entry = /^(.+\.go):(\d+):\s+(\S+)\s+([\d.]+)%$/
  for (const raw of text.split(/\r?\n/)) {
    const match = entry.exec(raw.trim())
    if (!match) continue
    const [, importPath = '', line, name = '', percent] = match
    const file = goFilePath(importPath, modules)
    const list = result.get(file) ?? []
    list.push({ name, line: Number(line), hits: Number(percent) > 0 ? 1 : 0 })
    result.set(file, list)
  }
  return result
}

/** Adds `go tool cover -func` functions to a parsed profile and fills the functions summary. */
export function withGoFunctions(
  report: CoverageReport,
  functions: Map<string, FunctionHit[]>,
): CoverageReport {
  const files = report.files.map((file) => ({
    ...file,
    functions: functions.get(file.file) ?? file.functions,
  }))
  const all = files.flatMap((file) => file.functions)
  return {
    ...report,
    files,
    summary: all.length
      ? {
          ...report.summary,
          functions: { covered: all.filter((fn) => fn.hits > 0).length, total: all.length },
        }
      : report.summary,
  }
}
