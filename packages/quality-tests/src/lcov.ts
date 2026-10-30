import { isAbsolute, relative } from 'node:path'

import type { CoverageSummary } from '@holtkeeper/quality'

import { languageOf } from './files.ts'
import type { BranchHit, CoverageReport, FileCoverage, FunctionHit, TestLanguage } from './types.ts'

/** `/`-separated path relative to `dir`; absolute paths outside `dir` stay absolute. */
export function relativeTo(dir: string | undefined, path: string): string {
  let rel = path
  if (dir && isAbsolute(path)) {
    const candidate = relative(dir, path)
    if (!candidate.startsWith('..') && !isAbsolute(candidate)) rel = candidate
  }
  return rel.replaceAll('\\', '/').replace(/^\.\//, '')
}

/** Languages of the files in a report, in a stable order. */
export function languagesOf(files: readonly FileCoverage[]): TestLanguage[] {
  const found = new Set(files.map((file) => languageOf(file.file)))
  return (['js', 'go', 'python'] as const).filter((language) => found.has(language))
}

interface Totals {
  lines: { covered: number; total: number }
  functions: { covered: number; total: number }
  hasFunctions: boolean
}

/** Sums line and function counts over files, using the tool's own `LF/LH/FNF/FNH` when present. */
function summarize(files: FileCoverage[], totals: Totals): CoverageSummary {
  const summary: CoverageSummary = { lines: totals.lines }
  if (totals.hasFunctions) summary.functions = totals.functions
  else if (files.some((file) => file.functions.length)) {
    const all = files.flatMap((file) => file.functions)
    summary.functions = { covered: all.filter((fn) => fn.hits > 0).length, total: all.length }
  }
  return summary
}

/**
 * Parses an lcov tracefile (`SF`, `FN`, `FNDA`, `DA`, `BRDA`, `LF/LH`, `FNF/FNH` records) as
 * written by Bun, c8/istanbul (vitest, jest), Node's test runner and coverage.py. Paths become
 * relative to `dir` when given. Unknown records are ignored.
 */
export function parseLcov(text: string, dir?: string): CoverageReport {
  const files: FileCoverage[] = []
  const totals: Totals = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    hasFunctions: false,
  }

  let current: FileCoverage | undefined
  let lines = new Map<number, number>()
  let functions = new Map<string, FunctionHit>()
  let reported: { lf?: number; lh?: number; fnf?: number; fnh?: number } = {}

  const finish = () => {
    if (!current) return
    current.lines = [...lines]
      .map(([line, hits]) => ({ line, hits }))
      .toSorted((a, b) => a.line - b.line)
    current.functions = [...functions.values()].toSorted((a, b) => a.line - b.line)
    totals.lines.total += reported.lf ?? current.lines.length
    totals.lines.covered += reported.lh ?? current.lines.filter((line) => line.hits > 0).length
    if (reported.fnf !== undefined || current.functions.length) {
      totals.hasFunctions = true
      totals.functions.total += reported.fnf ?? current.functions.length
      totals.functions.covered +=
        reported.fnh ?? current.functions.filter((fn) => fn.hits > 0).length
    }
    files.push(current)
    current = undefined
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line === 'end_of_record') {
      finish()
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const tag = line.slice(0, colon)
    const value = line.slice(colon + 1)

    if (tag === 'SF') {
      finish()
      current = { file: relativeTo(dir, value), lines: [], functions: [], branches: [] }
      lines = new Map()
      functions = new Map()
      reported = {}
      continue
    }
    if (!current) continue

    switch (tag) {
      case 'DA': {
        const [lineNo, hits] = value.split(',')
        const n = Number(lineNo)
        if (Number.isInteger(n)) lines.set(n, Math.max(lines.get(n) ?? 0, Number(hits) || 0))
        break
      }
      case 'FN': {
        // lcov 1: `FN:<line>,<name>`; lcov 2: `FN:<start>,<end>,<name>`. Names may contain commas.
        const parts = value.split(',')
        const start = Number(parts[0])
        const hasEnd = parts.length > 2 && /^\d+$/.test(parts[1] ?? '')
        const name = parts.slice(hasEnd ? 2 : 1).join(',')
        if (!Number.isInteger(start) || !name) break
        const fn: FunctionHit = { name, line: start, hits: functions.get(name)?.hits ?? 0 }
        if (hasEnd) fn.endLine = Number(parts[1])
        functions.set(name, fn)
        break
      }
      case 'FNDA': {
        const comma = value.indexOf(',')
        const hits = Number(value.slice(0, comma)) || 0
        const name = value.slice(comma + 1)
        const fn = functions.get(name)
        if (fn) fn.hits = hits
        else functions.set(name, { name, line: 0, hits })
        break
      }
      case 'BRDA': {
        const [lineNo, block = '', branch = '', taken = '-'] = value.split(',')
        const hit: BranchHit = { line: Number(lineNo), block, branch }
        if (taken !== '-') hit.taken = Number(taken) || 0
        current.branches.push(hit)
        break
      }
      case 'LF':
        reported.lf = Number(value)
        break
      case 'LH':
        reported.lh = Number(value)
        break
      case 'FNF':
        reported.fnf = Number(value)
        break
      case 'FNH':
        reported.fnh = Number(value)
        break
    }
  }
  finish()

  // FNDA without FN (some writers) leaves line 0; such entries cannot be placed and are dropped.
  for (const file of files) file.functions = file.functions.filter((fn) => fn.line > 0)
  return { format: 'lcov', languages: languagesOf(files), files, summary: summarize(files, totals) }
}
