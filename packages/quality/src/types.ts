import type { CodeChange, Range } from '@holtkeeper/changes'
import type { CommandRunner } from '@holtkeeper/exec'

export type QualityCategory = 'convention' | 'tests' | 'lint' | 'security' | 'style'

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

export interface ToolRun {
  name: string
  version?: string
  ok: boolean
  error?: string
  /** Why a check that applies to the project found nothing to run, e.g. its tool is not installed. */
  skipped?: string
  durationMs?: number
}

/** Everything the checks of one run found, merged; serializable. */
export interface QualityData {
  tools: ToolRun[]
  issues: QualityIssue[]
  changes: CodeChange[]
}

export interface QualityContext {
  dir: string
  runner: CommandRunner
  signal?: AbortSignal
}

/**
 * What one check contributes; `analyzeQuality` merges contributions. `skipped` says why the check
 * looked at nothing, so an empty result is not mistaken for a clean project.
 */
export type QualityResult = Partial<Omit<QualityData, 'tools'>> & {
  version?: string
  skipped?: string
}

/**
 * One source of findings on a checkout, e.g. leaked secrets or missing test ids. Checks are
 * independent and replaceable.
 */
export interface QualityCheck {
  readonly name: string
  /** Whether the check applies to the project, e.g. a config file or language is present. */
  detect(dir: string): Promise<boolean>
  run(context: QualityContext): Promise<QualityResult>
}
