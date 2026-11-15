import { type KvStore, keepKv, updateKv } from '@holtkeeper/store'
import { z } from 'zod'

import {
  type SecretReport,
  type SecretReportInput,
  type SecretReportStatus,
  type SecretReporter,
  exposureChannels,
  isOpenStatus,
  reportStatuses,
  secretKinds,
} from './model.ts'

const reportsKey = 'secret-reports:list'

const reportSchema = z.object({
  id: z.string(),
  kind: z.enum(secretKinds),
  identifier: z.string(),
  service: z.string().optional(),
  masked: z.string(),
  fingerprint: z.string().optional(),
  channel: z.enum(exposureChannels),
  repo: z.string().optional(),
  circumstances: z.string().optional(),
  status: z.enum(reportStatuses),
  reportedAt: z.string(),
  reporter: z.object({ id: z.string(), name: z.string() }).optional(),
  repeats: z.number(),
  note: z.string().optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
})

/** What `submit` did: stored a new report or counted a repeat of an open one. */
export type SubmitResult = { status: 'reported' | 'repeated'; report: SecretReport }

/** Stored secret reports. */
export interface SecretReportStore {
  /**
   * Stores a report; `reporter` only for named reports. An open report of the same kind,
   * identifier, service, mask and fingerprint gets its `repeats` raised instead, without any
   * trace of who repeated it or when.
   */
  submit(input: SecretReportInput, reporter?: SecretReporter): Promise<SubmitResult>
  /** Every report, newest first. */
  list(): Promise<SecretReport[]>
  get(id: string): Promise<SecretReport | undefined>
  /** Changes status and note; `undefined` when there is no such report. */
  update(
    id: string,
    patch: { status?: SecretReportStatus; note?: string },
    by: string,
  ): Promise<SecretReport | undefined>
}

/** Options of `secretReportStore`. */
export interface SecretReportStoreOptions {
  kv: KvStore
  now?: () => Date
  /** Most reports kept; the oldest closed ones go first. Default 1000. */
  limit?: number
}

const sameExposure = (a: SecretReportInput, b: SecretReportInput) =>
  a.kind === b.kind &&
  a.identifier.toLowerCase() === b.identifier.toLowerCase() &&
  (a.service ?? '').toLowerCase() === (b.service ?? '').toLowerCase() &&
  a.masked === b.masked &&
  (a.fingerprint ?? '') === (b.fingerprint ?? '')

// The stored order follows from the content alone, never from arrival, so the position of an
// anonymous report among others of its day says nothing about when it came.
const newestFirst = (a: SecretReport, b: SecretReport) =>
  b.reportedAt.localeCompare(a.reportedAt) || a.id.localeCompare(b.id)

const startOfDay = (at: Date) => `${at.toISOString().slice(0, 10)}T00:00:00.000Z`

const clean = (input: SecretReportInput): SecretReportInput => ({
  kind: input.kind,
  identifier: input.identifier,
  ...(input.service && { service: input.service }),
  masked: input.masked,
  ...(input.fingerprint && { fingerprint: input.fingerprint }),
  channel: input.channel,
  ...(input.repo && { repo: input.repo }),
  ...(input.circumstances && { circumstances: input.circumstances }),
})

/**
 * Secret reports in one key-value entry. Writes use `compareAndSet` when the store has it, so
 * several server processes do not lose each other's reports.
 */
export function secretReportStore({
  kv,
  now = () => new Date(),
  limit = 1000,
}: SecretReportStoreOptions): SecretReportStore {
  const read = async (): Promise<SecretReport[]> => {
    const parsed = z.array(reportSchema).safeParse(await kv.get(reportsKey))
    return parsed.success ? parsed.data : []
  }

  const trim = (reports: SecretReport[]) => {
    const sorted = reports.toSorted(newestFirst)
    if (sorted.length <= limit) return sorted
    const keep = new Set(
      [
        ...sorted.filter((report) => isOpenStatus(report.status)),
        ...sorted.filter((report) => !isOpenStatus(report.status)),
      ].slice(0, limit),
    )
    return sorted.filter((report) => keep.has(report))
  }

  /** Applies `change` to the stored list and writes it; retries when another writer won. */
  async function modify<T>(
    change: (reports: SecretReport[]) => [SecretReport[] | typeof keepKv, T],
  ): Promise<T> {
    let result!: T
    let kept = false
    const written = await updateKv(
      kv,
      reportsKey,
      (current) => {
        const parsed = z.array(reportSchema).safeParse(current)
        const [next, value] = change(parsed.success ? parsed.data : [])
        result = value
        kept = next === keepKv
        return next === keepKv ? keepKv : trim(next)
      },
      8,
    )
    if (written === undefined && !kept)
      throw new Error('secret reports: too many concurrent writes, try again')
    return result
  }

  return {
    submit: async (input, reporter) =>
      modify((reports): [SecretReport[], SubmitResult] => {
        const open = reports.find(
          (report) => isOpenStatus(report.status) && sameExposure(report, input),
        )
        if (open) {
          const repeated = { ...open, repeats: open.repeats + 1 }
          return [
            reports.map((report) => (report === open ? repeated : report)),
            { status: 'repeated', report: repeated },
          ]
        }
        const at = now()
        const report: SecretReport = {
          ...clean(input),
          id: crypto.randomUUID(),
          status: 'new',
          reportedAt: reporter ? at.toISOString() : startOfDay(at),
          ...(reporter && { reporter: { id: reporter.id, name: reporter.name } }),
          repeats: 0,
        }
        return [[...reports, report], { status: 'reported', report }]
      }),

    list: async () => (await read()).toSorted(newestFirst),

    get: async (id) => (await read()).find((report) => report.id === id),

    update: async (id, patch, by) =>
      modify((reports): [SecretReport[] | typeof keepKv, SecretReport | undefined] => {
        const found = reports.find((report) => report.id === id)
        if (!found) return [keepKv, undefined]
        const { note: _previous, ...rest } = found
        const note = patch.note === undefined ? found.note : patch.note.trim()
        const updated: SecretReport = {
          ...rest,
          ...(patch.status && { status: patch.status }),
          ...(note && { note }),
          updatedAt: now().toISOString(),
          updatedBy: by,
        }
        return [reports.map((report) => (report === found ? updated : report)), updated]
      }),
  }
}
