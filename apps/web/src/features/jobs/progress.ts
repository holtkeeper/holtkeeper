import type { JobStep } from '@holtkeeper/api'

import type { Segment } from '../../ui/SegmentBar.tsx'

const stepTones = { running: 'info', succeeded: 'success', failed: 'danger' } as const

/**
 * The progress bar of a job's side sheet from the top-level steps of its shown attempt: one
 * segment per step toned by its status, captioned "Step 5 of 7 · name" while a step runs, by the
 * failed step once one failed, else by the number of steps. `undefined` before any step is known.
 */
export function jobProgress(
  steps: readonly JobStep[],
): { segments: Segment[]; label: string } | undefined {
  const top = steps.filter((step) => step.depth === 0)
  if (!top.length) return undefined
  const segments = top.map((step) => ({
    value: 1,
    tone: stepTones[step.status],
    label: `${step.name} ${step.status}`,
  }))
  const failed = top.find((step) => step.status === 'failed')
  const running = top.findLastIndex((step) => step.status === 'running')
  const label = failed
    ? `Failed in ${failed.name}`
    : running >= 0
      ? `Step ${running + 1} of ${top.length} · ${top[running]?.name ?? ''}`
      : `${top.length} ${top.length === 1 ? 'step' : 'steps'}`
  return { segments, label }
}
