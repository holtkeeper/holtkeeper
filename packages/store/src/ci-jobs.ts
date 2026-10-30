import type { CiJobRecord, CiJobStore } from './types.ts'

const key = (record: Pick<CiJobRecord, 'repo' | 'jobId'>) =>
  `${record.repo.forge}\u0000${record.repo.path}\u0000${record.jobId}`

const isoOf = (value: string | undefined) =>
  value === undefined ? undefined : new Date(value).toISOString()

/** A record with every time in the contract's ISO 8601 form; stores apply it on `put`. */
export function normalizeCiJob(record: CiJobRecord): CiJobRecord {
  const startedAt = isoOf(record.startedAt)
  const finishedAt = isoOf(record.finishedAt)
  return {
    ...structuredClone(record),
    createdAt: new Date(record.createdAt).toISOString(),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  }
}

/** Oldest first, ties by job id: the order `CiJobStore.list` returns. */
export const compareCiJobs = (a: CiJobRecord, b: CiJobRecord) =>
  a.createdAt.localeCompare(b.createdAt) || a.jobId - b.jobId

export function memoryCiJobs(): CiJobStore {
  const records = new Map<string, CiJobRecord>()
  const of = (repo: CiJobRecord['repo']) =>
    [...records.values()].filter((r) => r.repo.forge === repo.forge && r.repo.path === repo.path)
  return {
    async put(list) {
      for (const record of list) records.set(key(record), normalizeCiJob(record))
    },
    async list(repo, { from, to } = {}) {
      return of(repo)
        .filter(
          (r) =>
            (from === undefined || r.createdAt >= from) && (to === undefined || r.createdAt < to),
        )
        .toSorted(compareCiJobs)
        .map((r) => structuredClone(r))
    },
    async coverage(repo) {
      const list = of(repo).toSorted(compareCiJobs)
      const [oldest, newest] = [list[0], list.at(-1)]
      return oldest && newest
        ? { oldest: oldest.createdAt, newest: newest.createdAt, jobs: list.length }
        : undefined
    },
    async prune(before) {
      let removed = 0
      for (const [k, record] of records)
        if (record.createdAt < before) {
          records.delete(k)
          removed++
        }
      return removed
    },
  }
}
