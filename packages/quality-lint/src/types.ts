import type { CodeChange } from '@holtkeeper/changes'
import type { QualityIssue } from '@holtkeeper/quality'

/** What a linter run produced: issues, and the fixes it proposed for some of them. */
export interface LintFindings {
  issues: QualityIssue[]
  /** Every change is referenced by the `changeId` of the issue it fixes. */
  changes: CodeChange[]
}

/**
 * One ready-made linter. `lintCheck` runs it in the project directory only when `detect` is true
 * and the version command succeeds (the tool is installed), so adapters never decide that on
 * their own.
 */
export interface LinterAdapter {
  /** Tool name, used as `QualityIssue.tool` and `CodeChange.source`. */
  readonly name: string
  /** Whether the project configures or depends on the tool. Reads files only, runs nothing. */
  detect(dir: string): Promise<boolean>
  /** The lint command, run with `dir` as working directory; it prints its report to stdout. */
  command(dir: string): string[]
  /** Prints the version; defaults to the binary of `command` with `--version`. */
  versionCommand?(dir: string): string[]
  /** Exit codes of a completed run; linters usually exit 1 when they found problems. Default `[0, 1]`. */
  readonly okExitCodes?: readonly number[]
  /** Turns the command's stdout into findings with paths relative to `dir`. */
  parse(stdout: string, dir: string): Promise<LintFindings>
}
