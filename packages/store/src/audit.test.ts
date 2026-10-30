import { describe, expect, test } from 'bun:test'

import {
  AUDIT_GENESIS_HASH,
  auditHash,
  auditVerifyRange,
  canonicalJson,
  formatAuditEvents,
  memoryAudit,
  sealAuditEvent,
  verifyAuditEvents,
} from './audit.ts'
import type { AuditEvent, AuditEventInput } from './types.ts'

const input = (action: string, overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  at: '2026-10-30T09:00:00.000Z',
  actor: { id: 'alice', name: 'Alice', provider: 'users' },
  via: 'ui',
  action,
  target: { type: 'credential', id: 'c1' },
  outcome: 'ok',
  ...overrides,
})

function chain(count: number): AuditEvent[] {
  const events: AuditEvent[] = []
  for (let i = 0; i < count; i++) events.push(sealAuditEvent(input(`a.${i}`), events.at(-1)))
  return events
}

const all = (events: AuditEvent[]) => ({ from: 1, to: events.at(-1)?.seq ?? 0 })

async function text(chunks: AsyncIterable<string>) {
  let out = ''
  for await (const chunk of chunks) out += chunk
  return out
}

async function* from(events: AuditEvent[]) {
  yield* events
}

describe('canonicalJson', () => {
  test('sorts keys at every level and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, undefined], c: undefined, b: null } })).toBe(
      '{"a":{"b":null,"d":[3,null]},"b":1}',
    )
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })
})

describe('audit hash chain', () => {
  test('sealed events link to the previous hash, starting from genesis', () => {
    const [first, second] = chain(2)
    expect(first?.prevHash).toBe(AUDIT_GENESIS_HASH)
    expect(second?.prevHash).toBe(first?.hash)
    expect(second && auditHash(second)).toBe(second?.hash)
  })

  test('detects edited, relinked, removed and truncated events', async () => {
    const events = chain(4)
    expect(await verifyAuditEvents(events, all(events))).toEqual({
      ok: true,
      checked: 4,
      firstSeq: 1,
      lastSeq: 4,
    })

    const edited = events.map((e) => (e.seq === 2 ? { ...e, action: 'a.forged' } : e))
    expect((await verifyAuditEvents(edited, all(events))).broken).toMatchObject({
      seq: 2,
      reason: 'hash',
    })

    const resealed = edited.map((e) => (e.seq === 2 ? { ...e, hash: auditHash(e) } : e))
    expect((await verifyAuditEvents(resealed, all(events))).broken).toMatchObject({
      seq: 3,
      reason: 'link',
    })

    const missing = events.filter((e) => e.seq !== 3)
    expect((await verifyAuditEvents(missing, all(events))).broken).toMatchObject({
      seq: 4,
      reason: 'gap',
    })

    expect(await verifyAuditEvents(events.slice(0, 2), all(events))).toMatchObject({
      ok: false,
      checked: 2,
      broken: { seq: 2, reason: 'tail' },
    })
    expect((await verifyAuditEvents([], all(events))).broken).toMatchObject({ reason: 'tail' })

    const fakeStart = sealAuditEvent(input('x'), { seq: 0, hash: 'f'.repeat(64) })
    expect((await verifyAuditEvents([fakeStart], { from: 1, to: 1 })).broken).toMatchObject({
      reason: 'link',
    })
  })

  test('the verify range starts after swept events and ends at the head', () => {
    expect(auditVerifyRange({}, { headSeq: 9, sweptThrough: 3 })).toEqual({ from: 4, to: 9 })
    expect(auditVerifyRange({ fromSeq: 2, toSeq: 20 }, { headSeq: 9, sweptThrough: 3 })).toEqual({
      from: 4,
      to: 9,
    })
    expect(auditVerifyRange({ fromSeq: 6, toSeq: 7 }, { headSeq: 9, sweptThrough: 0 })).toEqual({
      from: 6,
      to: 7,
    })
  })

  test('memory store chains appends and verifies after sweeps', async () => {
    const audit = memoryAudit()
    await audit.append(input('a', { at: '2026-01-01T00:00:00.000Z' }))
    await audit.append(input('b', { at: '2026-02-01T00:00:00.000Z' }))
    expect(await audit.sweep('2026-01-15T00:00:00.000Z')).toBe(1)
    expect(await audit.verifyChain()).toMatchObject({ ok: true, checked: 1, firstSeq: 2 })
  })
})

describe('formatAuditEvents', () => {
  test('ndjson writes one event per line', async () => {
    const events = chain(2)
    const out = await text(formatAuditEvents(from(events), 'ndjson'))
    expect(
      out
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual(events)
  })

  test('csv quotes separators and defuses formulas', async () => {
    const event = sealAuditEvent(
      input('credential.update', {
        actor: { id: '=cmd()', name: 'Doe, "J"', provider: 'users' },
        changes: [{ field: 'name', before: 'a', after: 'b' }],
      }),
      undefined,
    )
    const [header, row] = (await text(formatAuditEvents(from([event]), 'csv'))).split('\n')
    expect(header?.startsWith('seq,at,actor.id,actor.name')).toBe(true)
    expect(row).toContain(`1,2026-10-30T09:00:00.000Z,'=cmd(),"Doe, ""J""",users,ui`)
    expect(row).toContain('"[{""field"":""name"",""before"":""a"",""after"":""b""}]"')
  })
})
