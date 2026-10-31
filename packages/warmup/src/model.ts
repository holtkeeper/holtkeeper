import { z } from 'zod'

/** What one warm-up run did. */
export const warmupDataSchema = z.object({
  command: z.string(),
  /** Directory the command ran in, relative to the checkout; `.` for its root. */
  cwd: z.string(),
  /** Branch whose push queued the run, when a push did. */
  branch: z.string().optional(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  /** Whether the command was stopped by `timeoutMinutes`. */
  timedOut: z.boolean(),
  /** The last lines of standard output and error, oldest first. */
  output: z.string(),
  startedAt: z.string(),
})

export type WarmupData = z.output<typeof warmupDataSchema>
