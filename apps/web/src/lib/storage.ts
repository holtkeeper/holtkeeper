import type { ClearStorageResult, StorageProviderView } from '@holtkeeper/api'
import { formatBytes } from '@holtkeeper/api'

/** Available areas first, then largest first, then by label. */
export const sortProviders = (providers: StorageProviderView[]): StorageProviderView[] =>
  providers.toSorted(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      b.bytes - a.bytes ||
      a.label.localeCompare(b.label),
  )

/** Share of `bytes` in `total` as a 0..100 percentage; 0 when the total is empty. */
export const shareOf = (bytes: number, total: number): number =>
  total > 0 ? Math.min(100, Math.max(0, (bytes / total) * 100)) : 0

/**
 * `Removed 12 items · 3.4 MB`, `Asked 3 workers to clear their copies` for areas workers report,
 * or `Cleared` when the provider reports nothing.
 */
export function clearedMessage(result: ClearStorageResult | undefined): string {
  if (result?.requested !== undefined)
    return result.requested === 0
      ? 'No worker reports this area right now'
      : `Asked ${result.requested} ${result.requested === 1 ? 'worker' : 'workers'} to clear their copies`
  const parts = [
    result?.removed !== undefined
      ? `Removed ${result.removed} ${result.removed === 1 ? 'item' : 'items'}`
      : undefined,
    result?.bytes !== undefined ? formatBytes(result.bytes) : undefined,
  ].filter((part) => part !== undefined)
  return parts.length ? parts.join(' · ') : 'Cleared'
}

const shades = [86, 66, 50, 38, 28, 20, 14, 9] as const

/** Grey shade of the `index`-th storage area, from near-foreground down; meaning comes from the legend. */
export const storageShade = (index: number): string =>
  `color-mix(in oklab, var(--fg) ${shades[Math.min(index, shades.length - 1)]}%, transparent)`

/** Share of `bytes` in `total` as a label: `60%`, `<1%` for slivers, `0%` for nothing. */
export function shareLabel(bytes: number, total: number): string {
  const share = shareOf(bytes, total)
  if (share > 0 && share < 1) return '<1%'
  return `${Math.round(share)}%`
}

/** Change of an area against a week ago: `+1.2 GB`, `−200 MB` or `0`; absent without a past value. */
export function storageDelta(
  bytes: number,
  weekAgo: number | undefined,
): { text: string; trend: 'up' | 'down' | 'flat' } | undefined {
  if (weekAgo === undefined) return undefined
  const change = bytes - weekAgo
  if (change === 0) return { text: '0', trend: 'flat' }
  return change > 0
    ? { text: `+${formatBytes(change)}`, trend: 'up' }
    : { text: `−${formatBytes(-change)}`, trend: 'down' }
}

/**
 * How full a declared quota is: the bar's width (0..100), its label (`34%`, uncapped, so `112%`
 * when over) and a tone that turns warning from 80% and danger from 95%. Absent without a quota
 * or a measured figure.
 */
export function quotaUse(
  usedBytes: number | undefined,
  quotaBytes: number | undefined,
): { width: number; label: string; tone: 'default' | 'warning' | 'danger' } | undefined {
  if (usedBytes === undefined || !quotaBytes) return undefined
  const percent = (usedBytes / quotaBytes) * 100
  return {
    width: shareOf(usedBytes, quotaBytes),
    label: percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`,
    tone: percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'default',
  }
}

/**
 * Holtkeeper's own retention in words: `unused for 90 days`, `least used beyond 50 GB`, both
 * joined with ` · `, or `kept forever`.
 */
export function retentionLabel(
  retention: { days?: number; maxBytes?: number } | undefined,
): string {
  const parts = [
    retention?.days ? `unused for ${retention.days} ${retention.days === 1 ? 'day' : 'days'}` : '',
    retention?.maxBytes ? `least used beyond ${formatBytes(retention.maxBytes)}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'kept forever'
}
