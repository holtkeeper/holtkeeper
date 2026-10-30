import type {
  AuditEvent,
  AuditEventInput,
  AuditFilter,
  AuditStore,
  AuditVerification,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

/** `prevHash` of the first event in a chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64)

/** Events `AuditStore.export` reads per batch. */
export const AUDIT_EXPORT_BATCH = 500

/**
 * JSON with object keys sorted and `undefined` members dropped, so equal values always give the
 * same text whatever their key order or storage round trip.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/** SHA-256 (hex) of the canonical JSON of every field of the event except `hash`. */
export function auditHash(event: Omit<AuditEvent, 'hash'> & { hash?: string }): string {
  const { hash: _hash, ...rest } = event
  return new Bun.CryptoHasher('sha256').update(canonicalJson(rest)).digest('hex')
}

/** The stored form of an appended event: the input plus id, sequence number and chain hashes. */
export function sealAuditEvent(
  input: AuditEventInput,
  previous: { seq: number; hash: string } | undefined,
  id: string = crypto.randomUUID(),
): AuditEvent {
  const unsealed: Omit<AuditEvent, 'hash'> = {
    ...clone(input),
    id,
    seq: (previous?.seq ?? 0) + 1,
    prevHash: previous?.hash ?? AUDIT_GENESIS_HASH,
  }
  return { ...unsealed, hash: auditHash(unsealed) }
}

/** Whether an event passes every given field of the filter (see `AuditFilter`). */
export function matchesAuditFilter(event: AuditEvent, filter: AuditFilter = {}): boolean {
  return (
    (filter.actor === undefined || event.actor.id === filter.actor) &&
    (filter.action === undefined || event.action.startsWith(filter.action)) &&
    (filter.targetType === undefined || event.target.type === filter.targetType) &&
    (filter.targetId === undefined || event.target.id === filter.targetId) &&
    (filter.repo === undefined || event.target.repo === filter.repo) &&
    (filter.outcome === undefined || event.outcome === filter.outcome) &&
    (filter.via === undefined || event.via === filter.via) &&
    (filter.from === undefined || event.at >= filter.from) &&
    (filter.to === undefined || event.at < filter.to)
  )
}

/** Parses an `AuditPage.nextCursor`; `undefined` for missing or malformed cursors. */
export function auditCursorSeq(cursor: string | undefined): number | undefined {
  if (cursor === undefined || !/^\d+$/.test(cursor)) return undefined
  return Number(cursor)
}

/**
 * Checks events given oldest first by `seq` against the range `[from, to]` that should be fully
 * present: every `seq` in it exactly once, each hash matching its content, each `prevHash` the
 * hash before it, and `seq` 1 starting from the genesis hash. `to` below `from` means an empty
 * range.
 */
export async function verifyAuditEvents(
  events: Iterable<AuditEvent> | AsyncIterable<AuditEvent>,
  range: { from: number; to: number },
): Promise<AuditVerification> {
  let previous: AuditEvent | undefined
  let first: AuditEvent | undefined
  let checked = 0
  let expected = range.from
  const result = (broken?: AuditVerification['broken']): AuditVerification => ({
    ok: !broken,
    checked,
    ...(first && { firstSeq: first.seq }),
    ...(previous && { lastSeq: previous.seq }),
    ...(broken && { broken }),
  })
  for await (const event of events) {
    first ??= event
    if (event.seq !== expected) return result({ seq: event.seq, id: event.id, reason: 'gap' })
    if (auditHash(event) !== event.hash)
      return result({ seq: event.seq, id: event.id, reason: 'hash' })
    const linked = previous
      ? event.prevHash === previous.hash
      : event.seq !== 1 || event.prevHash === AUDIT_GENESIS_HASH
    if (!linked) return result({ seq: event.seq, id: event.id, reason: 'link' })
    previous = event
    checked++
    expected++
  }
  if (expected <= range.to)
    return result({ seq: previous?.seq ?? expected - 1, id: previous?.id ?? '', reason: 'tail' })
  return result()
}

/**
 * The range `verifyChain` must find complete: from the requested start or the first event after
 * the swept ones, to the requested end or the newest event ever appended.
 */
export const auditVerifyRange = (
  { fromSeq, toSeq }: { fromSeq?: number; toSeq?: number },
  state: { headSeq: number; sweptThrough: number },
) => ({
  from: Math.max(fromSeq ?? 1, state.sweptThrough + 1),
  to: Math.min(toSeq ?? state.headSeq, state.headSeq),
})

const csvColumns = [
  'seq',
  'at',
  'actor.id',
  'actor.name',
  'actor.provider',
  'via',
  'action',
  'target.type',
  'target.id',
  'target.repo',
  'outcome',
  'status',
  'request.method',
  'request.path',
  'request.ip',
  'changes',
  'details',
  'prevHash',
  'hash',
] as const

const csvCell = (value: unknown) => {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

const csvRow = (event: AuditEvent) =>
  [
    event.seq,
    event.at,
    event.actor.id,
    event.actor.name,
    event.actor.provider,
    event.via,
    event.action,
    event.target.type,
    event.target.id,
    event.target.repo,
    event.outcome,
    event.status,
    event.request?.method,
    event.request?.path,
    event.request?.ip,
    event.changes,
    event.details,
    event.prevHash,
    event.hash,
  ]
    .map(csvCell)
    .join(',')

/**
 * Serializes events as CSV (a header line, then one line per event; nested values as JSON, cells
 * that a spreadsheet would run as formulas prefixed with `'`) or NDJSON (one JSON event per line).
 */
export async function* formatAuditEvents(
  events: AsyncIterable<AuditEvent>,
  format: 'csv' | 'ndjson',
): AsyncGenerator<string> {
  if (format === 'csv') yield `${csvColumns.join(',')}\n`
  for await (const event of events)
    yield format === 'csv' ? `${csvRow(event)}\n` : `${JSON.stringify(event)}\n`
}

/** The in-memory `AuditStore`. */
export function memoryAudit(): AuditStore {
  const events: AuditEvent[] = []
  let head: { seq: number; hash: string } | undefined
  let sweptThrough = 0

  const matching = (filter: AuditFilter) =>
    events.filter((event) => matchesAuditFilter(event, filter))

  return {
    async append(input) {
      const event = sealAuditEvent(input, head)
      events.push(event)
      head = { seq: event.seq, hash: event.hash }
      return clone(event)
    },
    get: async (id) => clone(events.find((event) => event.id === id)),
    async list({ cursor, limit = 50, ...filter } = {}) {
      const before = auditCursorSeq(cursor)
      const page = matching(filter)
        .filter((event) => before === undefined || event.seq < before)
        .toReversed()
        .slice(0, limit + 1)
      const more = page.length > limit
      const kept = page.slice(0, limit)
      const last = kept.at(-1)
      return {
        events: kept.map(clone),
        ...(more && last && { nextCursor: String(last.seq) }),
      }
    },
    count: async (filter = {}) => matching(filter).length,
    async *export(filter = {}) {
      for (const event of matching(filter)) yield clone(event)
    },
    async sweep(before) {
      const keep = events.findIndex((event) => event.at >= before)
      const removed = keep === -1 ? events.length : keep
      const last = events[removed - 1]
      if (last) sweptThrough = last.seq
      events.splice(0, removed)
      return removed
    },
    async verifyChain(requested = {}) {
      const range = auditVerifyRange(requested, { headSeq: head?.seq ?? 0, sweptThrough })
      return verifyAuditEvents(
        events.filter((event) => event.seq >= range.from && event.seq <= range.to),
        range,
      )
    },
  }
}
