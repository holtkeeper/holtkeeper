import type { AnalysisSummary, JobSummary } from '@holtkeeper/api'

/** What a warm-up run's record says about the command; empty until the job stored one. */
export interface WarmupBuild {
  /** `ok`, `failed` or `timed out`. */
  status?: string
  durationMs?: number
  branch?: string
}

/**
 * Warm-up jobs joined with their records by `analysisId`, in the jobs' order. The branch comes
 * from the record, else from the job's `branch` option.
 */
export function warmupRuns(
  jobs: readonly JobSummary[],
  analyses: readonly AnalysisSummary[],
): { job: JobSummary; analysis?: AnalysisSummary; build: WarmupBuild }[] {
  const byId = new Map(analyses.map((analysis) => [analysis.id, analysis]))
  return jobs.map((job) => {
    const analysis = job.analysisId ? byId.get(job.analysisId) : undefined
    const metric = (id: string) => analysis?.metrics.find((m) => m.id === id)?.value
    const status = metric('status')
    const duration = metric('duration')
    const branch = metric('branch') ?? job.options.branch
    return {
      job,
      ...(analysis && { analysis }),
      build: {
        ...(typeof status === 'string' && { status }),
        ...(typeof duration === 'number' && { durationMs: duration }),
        ...(typeof branch === 'string' && { branch }),
      },
    }
  })
}
