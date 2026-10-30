import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { stableId, type TestSuggestion } from '@holtkeeper/quality'

import { isExcludedByName, isGeneratedSource, isTestFile, languageOf, listFiles } from './files.ts'
import { codeLines, findFunctions, isTypeOnlySource, type SourceFunction } from './symbols.ts'
import type {
  CoverageReport,
  FileCoverage,
  FunctionHit,
  TestFramework,
  TestLanguage,
} from './types.ts'

export interface RankOptions {
  dir: string
  coverage: CoverageReport
  /** Commits per file in the churn window, e.g. from `collectChurn`. */
  churn?: ReadonlyMap<string, number>
  /** Churn window in days, for the reason text. Default 90. */
  churnDays?: number
  /** Framework per language, recorded on suggestions. */
  frameworks?: Partial<Record<TestLanguage, TestFramework>>
  /** Default 10. */
  top?: number
  /** Functions with line coverage at or above this share are not suggested. Default 0.5. */
  maxCoverage?: number
  /** Functions shorter than this many lines are not suggested. Default 3. */
  minLines?: number
  /** Source files to consider (relative); default: every source file of the report's languages. */
  files?: readonly string[]
}

/** A function worth testing, before it becomes a `TestSuggestion`. */
export interface RankedTarget {
  file: string
  fn: SourceFunction
  covered: number
  total: number
  /** Function span in lines. */
  lines: number
  /** 1 + decision points. */
  complexity: number
  churn: number
  score: number
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`
}

/** Human reason for a target, e.g. `No test covers createSession; 42 lines, changed 7 times in 90 days`. */
export function reasonFor(target: RankedTarget, churnDays = 90): string {
  const name = target.fn.name
  const head =
    target.covered === 0
      ? `No test covers ${name}`
      : `${name} is ${Math.round((target.covered / target.total) * 100)}% covered (${target.covered} of ${plural(target.total, 'line')})`
  const facts = [plural(target.lines, 'line')]
  if (target.complexity > 1) facts.push(plural(target.complexity - 1, 'branch', 'branches'))
  if (target.churn > 0) facts.push(`changed ${plural(target.churn, 'time')} in ${churnDays} days`)
  return `${head}; ${facts.join(', ')}`
}

/**
 * Priority of an untested function: the uncovered share, weighted by size and decision points
 * and amplified by recent churn. Pure; exported so the weighting is documented by tests.
 */
export function targetScore(
  target: Pick<RankedTarget, 'covered' | 'total' | 'lines' | 'complexity' | 'churn'>,
): number {
  const gap = target.total ? 1 - target.covered / target.total : 1
  return gap * (Math.log2(1 + target.lines) + target.complexity) * (1 + Math.log2(1 + target.churn))
}

function hitFor(fn: SourceFunction, hits: readonly FunctionHit[]): FunctionHit | undefined {
  const short = fn.name.slice(fn.name.lastIndexOf('.') + 1)
  return (
    hits.find(
      (hit) => hit.line >= fn.startLine && hit.line <= Math.min(fn.endLine, fn.startLine + 2),
    ) ?? hits.find((hit) => hit.name === fn.name || hit.name === short)
  )
}

function measure(
  fn: SourceFunction,
  text: string,
  language: TestLanguage,
  coverage: FileCoverage | undefined,
) {
  if (!coverage)
    return {
      covered: 0,
      total: codeLines(text, language, fn.startLine, fn.endLine),
      branches: undefined,
    }
  const inRange = coverage.lines.filter(
    (line) => line.line >= fn.startLine && line.line <= fn.endLine,
  )
  const hit = hitFor(fn, coverage.functions)
  const decisions = new Set(
    coverage.branches
      .filter((b) => b.line >= fn.startLine && b.line <= fn.endLine)
      .map((b) => `${b.line}:${b.block}`),
  )
  const branches = decisions.size ? decisions.size : undefined
  if (inRange.length)
    return {
      covered: inRange.filter((line) => line.hits > 0).length,
      total: inRange.length,
      branches,
    }
  if (hit && hit.hits === 0)
    return { covered: 0, total: codeLines(text, language, fn.startLine, fn.endLine), branches }
  return undefined
}

/**
 * Finds functions with no or low coverage and orders them by how much a test would help:
 * uncovered share, size, decision points (lcov `BRDA` when present, else counted in source) and
 * churn. Test files, generated files, declaration and config files, and type-only modules are
 * skipped. Source files of the report's languages that no test loaded count as uncovered.
 * Returns at most `top` targets, best first.
 */
export async function findTestTargets(options: RankOptions): Promise<RankedTarget[]> {
  const {
    dir,
    coverage,
    churn = new Map<string, number>(),
    maxCoverage = 0.5,
    minLines = 3,
  } = options
  const languages = new Set(coverage.languages)
  const byFile = new Map(coverage.files.map((file) => [file.file, file]))
  const candidates = new Set(options.files ?? (await listFiles(dir)))
  if (!options.files) for (const file of byFile.keys()) candidates.add(file)

  const targets: RankedTarget[] = []
  for (const file of [...candidates].toSorted()) {
    const language = languageOf(file)
    if (!language || !languages.has(language) || isTestFile(file) || isExcludedByName(file))
      continue
    if (file.startsWith('/') || file.split('/').includes('node_modules')) continue
    let text: string
    try {
      // oxlint-disable-next-line no-await-in-loop
      text = await readFile(join(dir, file), 'utf8')
    } catch {
      continue
    }
    if (isGeneratedSource(text) || (language === 'js' && isTypeOnlySource(text))) continue

    for (const fn of findFunctions(text, language)) {
      const lines = fn.endLine - fn.startLine + 1
      if (lines < minLines) continue
      const measured = measure(fn, text, language, byFile.get(file))
      if (!measured || measured.total === 0) continue
      if (measured.covered / measured.total >= maxCoverage) continue
      const target = {
        file,
        fn,
        covered: measured.covered,
        total: measured.total,
        lines,
        complexity: 1 + (measured.branches ?? fn.branches),
        churn: churn.get(file) ?? 0,
        score: 0,
      }
      target.score = targetScore(target)
      targets.push(target)
    }
  }
  return targets
    .toSorted(
      (a, b) =>
        b.score - a.score || a.file.localeCompare(b.file) || a.fn.startLine - b.fn.startLine,
    )
    .slice(0, options.top ?? 10)
}

/** Turns a ranked target into the shared `TestSuggestion` shape. */
export function toSuggestion(
  target: RankedTarget,
  options: Pick<RankOptions, 'churnDays' | 'frameworks'> = {},
): TestSuggestion {
  const language = languageOf(target.file)
  const framework = language ? options.frameworks?.[language] : undefined
  return {
    id: stableId('tests', target.file, target.fn.name),
    file: target.file,
    symbol: target.fn.name,
    kind: target.fn.kind,
    range: {
      start: { line: target.fn.startLine, column: 1 },
      end: { line: target.fn.endLine + 1, column: 1 },
    },
    reason: reasonFor(target, options.churnDays),
    coverage: { covered: target.covered, total: target.total },
    complexity: target.complexity,
    churn: target.churn,
    ...(framework ? { framework } : {}),
  }
}

/** `findTestTargets` as `TestSuggestion`s with a human `reason`, best first. */
export async function rankTestTargets(options: RankOptions): Promise<TestSuggestion[]> {
  return (await findTestTargets(options)).map((target) => toSuggestion(target, options))
}
