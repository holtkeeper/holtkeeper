import type { GitForge, MergeRequestDiff, Pipeline, PipelineStatus } from '@holtkeeper/forge'

import type { MergeRequestEvent, PipelineState } from './model.ts'

/**
 * Facts about the merge request that cost forge requests. Each loads at most once per evaluation
 * and only when first asked for.
 */
export interface MergeRequestFacts {
  /** The head commit; `undefined` when neither the event nor the forge provide it. */
  headSha(): Promise<string | undefined>
  /** The diff; `undefined` when the forge cannot load diffs. */
  diff(): Promise<MergeRequestDiff | undefined>
  /** Latest pipeline for the head commit. */
  pipeline(): Promise<{ state: PipelineState; pipeline?: Pipeline }>
}

const lazy = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined
  return () => (value ??= load())
}

const stateOf: Record<PipelineStatus, PipelineState> = {
  success: 'success',
  failed: 'failed',
  canceled: 'failed',
  pending: 'running',
  running: 'running',
  manual: 'running',
  skipped: 'none',
}

/** Maps a forge pipeline status to the state policies match on. */
export const pipelineState = (status: PipelineStatus): PipelineState => stateOf[status]

/** Lazy, memoized facts for one event. */
export function createFacts(forge: GitForge, event: MergeRequestEvent): MergeRequestFacts {
  const repo = event.repo.path
  const id = event.mr.id
  const diff = lazy(async () => forge.getMergeRequestDiff?.(repo, id))
  const headSha = lazy(async () => {
    if (event.mr.headSha) return event.mr.headSha
    if (forge.getMergeRequest) return (await forge.getMergeRequest(repo, id)).headSha
    return (await diff())?.refs.headSha
  })
  const pipeline = lazy(async () => {
    const sha = await headSha()
    if (!sha) return { state: 'none' as const }
    const latest = (await forge.listPipelines(repo, { sha })).toSorted((a, b) => b.id - a.id)[0]
    return latest
      ? { state: pipelineState(latest.status), pipeline: latest }
      : { state: 'none' as const }
  })
  return { headSha, diff, pipeline }
}
