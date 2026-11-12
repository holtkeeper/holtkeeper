import type { Segment } from '../../ui/SegmentBar.tsx'
import type { Tick } from '../../ui/TickStrip.tsx'

/**
 * The progress bar of a version's side sheet from its deploy ticks, one segment per environment
 * (environments it never reached are neutral), captioned with how many it is deployed to.
 * `undefined` when the repository deploys nowhere.
 */
export function deployProgress(
  ticks: readonly Tick[],
): { segments: Segment[]; label: string } | undefined {
  if (!ticks.length) return undefined
  const segments = ticks.map((tick) => ({
    value: 1,
    tone: tick.tone === 'skipped' ? ('default' as const) : tick.tone,
    label: tick.label ?? '',
  }))
  const deployed = ticks.filter((tick) => tick.tone === 'success').length
  return {
    segments,
    label: `Deployed to ${deployed} of ${ticks.length} ${ticks.length === 1 ? 'environment' : 'environments'}`,
  }
}
