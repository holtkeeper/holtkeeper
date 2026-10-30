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

/** `Removed 12 items · 3.4 MB`, or `Cleared` when the provider reports nothing. */
export function clearedMessage(result: ClearStorageResult | undefined): string {
  const parts = [
    result?.removed !== undefined
      ? `Removed ${result.removed} ${result.removed === 1 ? 'item' : 'items'}`
      : undefined,
    result?.bytes !== undefined ? formatBytes(result.bytes) : undefined,
  ].filter((part) => part !== undefined)
  return parts.length ? parts.join(' · ') : 'Cleared'
}
