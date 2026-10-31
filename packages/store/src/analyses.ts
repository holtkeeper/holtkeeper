import type { AnalysisRecord, AnalysisStore } from './types.ts'

/** Older records of one repository looked at when its newest one is rejected. */
const FALLBACK = 20

/**
 * The newest record of `kind` of every repository that `read` turns into a value, by
 * `forge:path`. Reads one record per repository through `latest`; only when `read` rejects it
 * (returns `undefined`) are up to 20 older records of that repository tried, newest first.
 * Repositories whose newest record `accept` rejects are left out without looking further.
 */
export async function newestRecords<T>(
  analyses: Pick<AnalysisStore, 'latest' | 'list'>,
  kind: string,
  read: (record: AnalysisRecord) => T | undefined,
  accept: (record: AnalysisRecord) => boolean = () => true,
): Promise<Map<string, { record: AnalysisRecord; value: T }>> {
  const found = new Map<string, { record: AnalysisRecord; value: T }>()
  const rejected: AnalysisRecord[] = []
  for (const record of await analyses.latest({ kind })) {
    if (!accept(record)) continue
    const value = read(record)
    if (value === undefined) rejected.push(record)
    else found.set(`${record.repo.forge}:${record.repo.path}`, { record, value })
  }
  await Promise.all(
    rejected.map(async (newest) => {
      const older = await analyses.list({
        repo: newest.repo,
        kind,
        before: newest.createdAt,
        limit: FALLBACK,
      })
      for (const record of older) {
        const value = read(record)
        if (value === undefined) continue
        found.set(`${record.repo.forge}:${record.repo.path}`, { record, value })
        return
      }
    }),
  )
  return new Map(
    [...found].toSorted(([, a], [, b]) => b.record.createdAt.localeCompare(a.record.createdAt)),
  )
}
