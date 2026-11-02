import type { Agent, Toolset } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'

import type { ReviewTest, ReviewTestRun } from './schema.ts'
import type { FileScope } from './scope.ts'

/** Limits of one test run; see the `review` analyzer for defaults. */
export interface ReviewTestOptions {
  /** Functions that get a test. */
  maxTests: number
  /** Runs on the head a test must pass to count as `passes`. */
  repeat: number
  /** Per test run. */
  timeoutMs: number
  /** Rounds of writing and running before a test is `unfinished`. */
  attempts: number
}

export const defaultReviewTestOptions: ReviewTestOptions = {
  maxTests: 2,
  repeat: 2,
  timeoutMs: 120_000,
  attempts: 3,
}

export interface MergeRequestTestInput {
  /** Checkout at `headSha`; the tester may write files in it but must leave it as it found it. */
  dir: string
  /** Runs the tests; the job's sandboxed runner. */
  runner: CommandRunner
  /** Already counts its usage into the review's. */
  agent: Agent
  /** Files in scope with their in-scope added lines. */
  files: readonly FileScope[]
  headSha: string
  mergeRequest: { title: string; description: string }
  /** Tests of the previous review of this merge request. */
  previous?: readonly ReviewTest[]
  options: ReviewTestOptions
  toolsets?: readonly Toolset[]
  log?: (line: string) => void
  signal?: AbortSignal
}

/**
 * Writes tests for the functions a merge request changes and runs them itself, so a verdict is
 * what the runner observed, never what the agent claims. Must not throw for a project it cannot
 * test: it returns `skipped` with the reason instead. Leaves the checkout as it found it.
 */
export interface MergeRequestTester {
  test(input: MergeRequestTestInput): Promise<ReviewTestRun>
}
