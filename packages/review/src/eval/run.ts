import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import { type CommandRunner, localRunner } from '@holtkeeper/exec'
import type { DiffFile, GitForge, ReviewSubmission } from '@holtkeeper/forge'

import {
  type ReviewForge,
  type ReviewOptions,
  requireReviewForge,
  reviewMergeRequest,
} from '../pipeline.ts'
import { DEFAULT_IGNORE } from '../scope.ts'
import type { EvalCase } from './case.ts'
import { type CaseResult, scoreCase } from './score.ts'
import { unifiedDiff } from './unified-diff.ts'

const HEAD = 'e'.repeat(40)
const BASE = 'a'.repeat(40)
const REPO = { forge: 'eval', path: 'eval/widgets' }

/** The review options the golden set runs with: the analyzer's defaults, nothing posted for real. */
export const EVAL_OPTIONS: ReviewOptions = {
  mergeRequest: 1,
  mode: 'full',
  maxComments: 15,
  minSeverity: 'minor',
  includeChecks: false,
  approve: 'never',
  ignore: [...DEFAULT_IGNORE],
  maxDiffLines: 3000,
  media: false,
}

/** The files of the repository as the change leaves them: context files and `after` versions. */
export function filesAfter(testCase: EvalCase): Record<string, string> {
  const files: Record<string, string> = { ...testCase.files }
  for (const [path, change] of Object.entries(testCase.changes))
    if (change.after !== undefined) files[path] = change.after
  if (testCase.guide !== undefined) files['REVIEW.md'] = testCase.guide
  return files
}

/** The merge request's diff, one `DiffFile` per changed file, in path order. */
export function diffOf(testCase: EvalCase): DiffFile[] {
  return Object.entries(testCase.changes)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, { before, after }]): DiffFile => {
      const status = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified'
      return {
        oldPath: path,
        newPath: path,
        status,
        diff: unifiedDiff(before ?? '', after ?? ''),
      }
    })
}

/** Writes the repository of `testCase` as it is after the change into `dir`. */
export async function materialize(testCase: EvalCase, dir: string): Promise<void> {
  for (const [path, text] of Object.entries(filesAfter(testCase))) {
    const file = join(dir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text)
  }
}

/** A forge serving one case's merge request; the review it submits is kept and never goes anywhere. */
export function evalForge(testCase: EvalCase): {
  forge: ReviewForge
  submitted: ReviewSubmission[]
} {
  const files = filesAfter(testCase)
  const diff = diffOf(testCase)
  const submitted: ReviewSubmission[] = []
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- serves only what the review reads
  const forge = {
    kind: 'gitlab',
    getMergeRequest: async () => ({
      id: 1,
      title: testCase.merge.title,
      description: testCase.merge.description,
      sourceBranch: 'feature/change',
      targetBranch: 'main',
      state: 'open' as const,
      draft: false,
      labels: [],
      author: 'dev',
      webUrl: `https://forge.test/eval/widgets/-/merge_requests/1`,
      headSha: HEAD,
    }),
    getMergeRequestDiff: async () => ({
      refs: { baseSha: BASE, startSha: BASE, headSha: HEAD },
      files: diff,
    }),
    listDiscussions: async () => [],
    compareCommits: async () => [],
    readFile: async (_repo: string, path: string) => files[path],
    submitReview: async (_repo: string, _id: number, review: ReviewSubmission) => {
      submitted.push(review)
      return { posted: review.comments.length, failed: [] }
    },
  } as unknown as GitForge
  return { forge: requireReviewForge(forge), submitted }
}

/** What running a case needs besides the case. */
export interface EvalEnvironment {
  /** Reviews the case; a real model for a measurement, a scripted one in tests. */
  agent: Agent
  /** Runs the agent's shell tools in the checkout; default the local machine. */
  runner?: CommandRunner
  /** Replaces `EVAL_OPTIONS`, e.g. to try another severity floor. */
  options?: Partial<ReviewOptions>
  log?: (line: string) => void
  signal?: AbortSignal
}

/**
 * Reviews `testCase` once in a temporary checkout and scores the comments the review posts.
 * A run that throws is a result with `error` and every expected problem missed, so one broken
 * case does not hide the rest.
 */
export async function runCase(
  testCase: EvalCase,
  environment: EvalEnvironment,
  run = 1,
): Promise<CaseResult> {
  const dir = await mkdtemp(join(tmpdir(), 'holtkeeper-eval-'))
  const started = Date.now()
  try {
    await materialize(testCase, dir)
    const { forge } = evalForge(testCase)
    const data = await reviewMergeRequest({
      repo: REPO,
      forge,
      dir,
      runner: environment.runner ?? localRunner,
      agent: environment.agent,
      options: { ...EVAL_OPTIONS, ...environment.options },
      ...(testCase.tests === false && { tests: false as const }),
      ...(environment.log && { log: environment.log }),
      ...(environment.signal && { signal: environment.signal }),
    })
    return {
      caseId: testCase.id,
      run,
      score: scoreCase(
        testCase,
        data.comments.filter((comment) => comment.posted),
      ),
      verdict: data.verdict,
      ...(data.usage && { usage: data.usage }),
      durationMs: Date.now() - started,
      expected: testCase.expected.length,
    }
  } catch (error) {
    return {
      caseId: testCase.id,
      run,
      score: scoreCase(testCase, []),
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      expected: testCase.expected.length,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Options of `runEval`. */
export interface EvalRun extends EvalEnvironment {
  cases: readonly EvalCase[]
  /** How many times each case is reviewed; models are not deterministic. Default 1. */
  repeat?: number
  /** Reviews running at once. Default 3. */
  concurrency?: number
  /** Called as each run finishes. */
  onResult?: (result: CaseResult) => void
}

/**
 * Reviews every case `repeat` times, `concurrency` at a time, and returns the results in case
 * order, repetition by repetition.
 */
export async function runEval(input: EvalRun): Promise<CaseResult[]> {
  const jobs = input.cases.flatMap((testCase) =>
    Array.from({ length: input.repeat ?? 1 }, (_, index) => ({ testCase, run: index + 1 })),
  )
  const results: (CaseResult | undefined)[] = []
  let next = 0
  const worker = async () => {
    for (let index = next++; index < jobs.length; index = next++) {
      const job = jobs[index]
      if (!job || input.signal?.aborted) return
      const result = await runCase(job.testCase, input, job.run)
      results[index] = result
      input.onResult?.(result)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency ?? 3) }, worker))
  return results.filter((result) => result !== undefined)
}
