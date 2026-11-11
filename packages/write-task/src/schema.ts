import { z } from 'zod'

/** Analyzer kind of write tasks; also the `taskKind` of their agent runs and usage records. */
export const WRITE_TASK_KIND = 'write-task'

/** Worker pool that alone claims write tasks (`serve --pool write`). */
export const WRITE_POOL = 'write'

/** Default spend cap of one write task on one repository, in USD. */
export const DEFAULT_TASK_BUDGET_USD = 1.5

/** What kind of change a task makes; it shapes the agent's instructions, nothing else. */
const writeTaskKinds = ['change', 'fix', 'port', 'tests'] as const

/** Options of one write task job, as the enqueuing side passes them. */
export const writeTaskOptionsSchema = z.object({
  /** Names the branch; tasks of one group share it, so every repository gets the same branch. */
  taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{3,39}$/),
  /** One line saying what the task does; the merge request title when no commit message is set. */
  title: z.string().trim().min(1).max(200),
  /** What the agent should do. Not needed when `patch` alone does the job. */
  prompt: z.string().max(20_000).optional(),
  kind: z.enum(writeTaskKinds).default('change'),
  /** A unified diff tried with `git apply -3` before any agent runs (ports, ready-made fixes). */
  patch: z.string().max(1_000_000).optional(),
  /** Preferred commit message; checked against the repository's conventions. */
  commitMessage: z.string().trim().min(1).max(500).optional(),
  /** Check commands to run instead of the detected ones; `[]` runs none. */
  checks: z.array(z.string().trim().min(1)).max(10).optional(),
  /** Spend cap of the agent run in USD. */
  budgetUsd: z.coerce.number().positive().max(5).default(DEFAULT_TASK_BUDGET_USD),
  maxTurns: z.coerce.number().int().min(1).max(100).default(40),
  /** The whole task is aborted after this long. */
  timeoutMinutes: z.coerce.number().int().min(1).max(60).default(20),
  /** Open the merge request as a draft. Failing checks always make it one. */
  draft: z.boolean().default(true),
  /** Branch the change starts from and targets. Default: the repository's default branch. */
  targetBranch: z.string().trim().min(1).optional(),
  /** Task group this task belongs to, when several repositories get the same change. */
  group: z.string().trim().min(1).optional(),
  /** The stored agent task this job carries out, for status updates. */
  task: z.string().trim().min(1).optional(),
})

export type WriteTaskOptions = z.infer<typeof writeTaskOptionsSchema>

const checkResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  ok: z.boolean(),
  exitCode: z.number(),
  /** Last lines of the output. */
  output: z.string(),
  durationMs: z.number(),
})

/** One check command and how it ended. */
export type CheckResult = z.infer<typeof checkResultSchema>

/** What one write task did: the analysis record of kind `write-task`. */
export const writeTaskDataSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  kind: z.enum(writeTaskKinds),
  /** `opened`: a merge request was opened or updated; `no-changes`: nothing to propose; `dry-run`: not published. */
  status: z.enum(['opened', 'no-changes', 'dry-run']),
  branch: z.string(),
  targetBranch: z.string(),
  /** How the change was made: the patch alone, the agent alone, or the patch then the agent. */
  path: z.enum(['patch', 'agent', 'patch+agent']),
  /** `applied`: `git apply -3` succeeded; `conflict`: it failed and the agent took over. */
  patch: z.enum(['applied', 'conflict']).optional(),
  files: z.array(z.string()),
  checks: z.array(checkResultSchema),
  commit: z.object({ message: z.string(), sha: z.string().optional() }).optional(),
  mergeRequest: z.object({ id: z.number(), url: z.string(), draft: z.boolean() }).optional(),
  agent: z
    .object({
      summary: z.string(),
      changes: z.array(z.string()),
      remainingProblems: z.array(z.string()),
      turns: z.number(),
      costUsd: z.number().optional(),
      transcriptRef: z.string().optional(),
    })
    .optional(),
  group: z.string().optional(),
})

export type WriteTaskData = z.infer<typeof writeTaskDataSchema>

/** What the agent answers with when it is done. */
export const agentReportSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  remainingProblems: z.array(z.string()),
  commitMessage: z.string().optional(),
})

export type AgentReport = z.infer<typeof agentReportSchema>
