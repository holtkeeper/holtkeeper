import type { ReviewCategory, ReviewSeverity } from '../schema.ts'

/** One problem a review of an `EvalCase` is expected to find. */
export interface ExpectedFinding {
  /** Unique within the case; names the problem in reports. */
  id: string
  /** File of the problem, as in the diff. */
  path: string
  /** New-side lines the problem sits on, from and to, inclusive. */
  lines: readonly [number, number]
  /** What is wrong and why, for the people who maintain the case. Never shown to the reviewer. */
  note: string
  /**
   * Words the comment must mention, case-insensitive: it counts when every word of at least one of
   * the inner lists appears in its title or body. Without it any comment on the lines counts.
   */
  mentions?: readonly (readonly string[])[]
  /** The finding counts as underrated when the review rates it lower. */
  minSeverity?: ReviewSeverity
  /** Categories the review may file it under; any when absent. */
  categories?: readonly ReviewCategory[]
}

/**
 * A small invented merge request with the problems a careful reviewer should find in it. Every
 * name and value in it is made up; it must not copy code of a repository Holtkeeper analyzes.
 */
export interface EvalCase {
  /** Unique, kebab-case; names the case in reports and on the command line. */
  id: string
  /** One line on what the case checks. */
  title: string
  /** The merge request's title and description, as the reviewer sees them. */
  merge: { title: string; description: string }
  /** Files present before and after the change, unchanged by it: context the reviewer can read. */
  files?: Readonly<Record<string, string>>
  /** Files the change touches: `before` is absent for an added file, `after` for a deleted one. */
  changes: Readonly<Record<string, { before?: string; after?: string }>>
  /**
   * Every real problem the change has. The review is scored as if this list were complete, so a
   * comment on anything else counts as a false positive: list real problems even when they are
   * minor. Empty for a change a reviewer should leave alone.
   */
  expected: readonly ExpectedFinding[]
  /** `false` for a repository with no tests by design, as `ReviewRun.tests`. */
  tests?: false
  /** Conventions of the repository, passed as the review's resolved rules. */
  guide?: string
}
