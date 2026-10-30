import type { Agent } from '@holtkeeper/agent'
import type { CodeChange, Range } from '@holtkeeper/changes'
import type { CommandRunner } from '@holtkeeper/exec'

export type QualityCategory =
  | 'convention'
  | 'tests'
  | 'complexity'
  | 'duplication'
  | 'lint'
  | 'security'
  | 'style'

export type IssueSeverity = 'error' | 'warning' | 'info'

/** One problem a check found. Tools differ; this is the shape every check reports in. */
export interface QualityIssue {
  /** Stable across runs for the same problem (tool, rule, file and the offending text). */
  id: string
  tool: string
  rule: string
  category: QualityCategory
  severity: IssueSeverity
  message: string
  /** Relative to the analyzed directory. */
  file?: string
  range?: Range
  help?: string
  url?: string
  /** A suggested fix in `QualityData.changes`. */
  changeId?: string
}

/** Code worth testing, with why and — when an agent wrote one — an example test. */
export interface TestSuggestion {
  id: string
  file: string
  symbol: string
  kind: 'function' | 'method' | 'class' | 'module'
  range?: Range
  reason: string
  /** Line coverage of the symbol, when coverage data exists. */
  coverage?: { covered: number; total: number }
  complexity?: number
  /** How often the file changed recently; risky untested code changes often. */
  churn?: number
  /** Test framework the example follows, e.g. `bun:test`, `vitest`, `go test`. */
  framework?: string
  testFile?: string
  changeId?: string
}

/** How consistently one kind of name is written, e.g. module-level constants in TypeScript. */
export interface ConventionStat {
  language: string
  /** e.g. `module constant`, `local variable`, `function`, `type`, `file name`. */
  kind: string
  /** Dominant style, e.g. `SCREAMING_SNAKE_CASE`, `camelCase`, `PascalCase`, `kebab-case`. */
  dominant: string
  /** Share of names in the dominant style, 0..1. */
  share: number
  total: number
  outliers: number
}

export interface CoverageSummary {
  lines?: { covered: number; total: number }
  functions?: { covered: number; total: number }
}

export interface DuplicationSummary {
  /** Share of duplicated lines, 0..100. */
  percentage: number
  duplicatedLines: number
  totalLines: number
}

export interface ToolRun {
  name: string
  version?: string
  ok: boolean
  error?: string
  durationMs?: number
}

/** Everything a quality analysis found; serializable, stored as analysis data. */
export interface QualityData {
  tools: ToolRun[]
  issues: QualityIssue[]
  tests: TestSuggestion[]
  conventions: ConventionStat[]
  coverage?: CoverageSummary
  duplication?: DuplicationSummary
  changes: CodeChange[]
}

export interface QualityContext {
  dir: string
  runner: CommandRunner
  /** Present when an LLM is configured; checks that need one skip themselves otherwise. */
  agent?: Agent
  signal?: AbortSignal
}

/** What one check contributes; `analyzeQuality` merges contributions. */
export type QualityResult = Partial<Omit<QualityData, 'tools'>> & { version?: string }

/**
 * One source of findings: a linter through SARIF, the conventions engine, coverage and test
 * suggestions, duplication. Checks are independent and replaceable.
 */
export interface QualityCheck {
  readonly name: string
  /** Whether the check applies to the project, e.g. a config file or language is present. */
  detect(dir: string): Promise<boolean>
  run(context: QualityContext): Promise<QualityResult>
}
