import type { AuditVerifyLast } from '@holtkeeper/api'
import type { KvStore, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { appendAudit } from './audit.ts'

const LAST_KEY = 'audit:verify:last'

const lastSchema = z.object({
  at: z.string(),
  result: z.object({
    ok: z.boolean(),
    checked: z.number(),
    firstSeq: z.number().optional(),
    lastSeq: z.number().optional(),
    broken: z
      .object({
        seq: z.number(),
        id: z.string(),
        reason: z.enum(['hash', 'link', 'gap', 'tail']),
      })
      .optional(),
  }),
})

/** The newest recorded chain check; empty before the first one or without `kv`. */
export async function lastAuditVerification(
  kv: Pick<KvStore, 'get'> | undefined,
): Promise<AuditVerifyLast> {
  const parsed = lastSchema.safeParse(await kv?.get(LAST_KEY))
  if (!parsed.success) return {}
  const { firstSeq, lastSeq, broken, ...rest } = parsed.data.result
  return {
    at: parsed.data.at,
    result: {
      ...rest,
      ...(firstSeq !== undefined && { firstSeq }),
      ...(lastSeq !== undefined && { lastSeq }),
      ...(broken && { broken }),
    },
  }
}

/**
 * Checks the whole hash chain, keeps the result in `kv` for `GET /api/audit/verify/last` and
 * appends an `audit.verify` event by the system (outcome `error` when the chain is broken), so the
 * log itself shows when it was checked. Without `kv` the result is only returned.
 */
async function recordAuditVerification(
  store: Pick<Store, 'audit' | 'kv'>,
  now: Date,
): Promise<Required<AuditVerifyLast>> {
  const result = await store.audit.verifyChain()
  const at = now.toISOString()
  await store.kv?.set(LAST_KEY, { at, result })
  await appendAudit(store, {
    at,
    actor: { id: 'system', name: 'System', provider: 'system' },
    via: 'system',
    action: 'audit.verify',
    target: { type: 'audit' },
    outcome: result.ok ? 'ok' : 'error',
    details: { ...result },
  })
  return { at, result }
}

const DAY_MS = 86_400_000

/**
 * Runs `recordAuditVerification` unless the last check is younger than a day, so a leader that
 * restarts often still checks once a day. Resolves with whether it checked.
 */
export async function verifyAuditChainIfDue(
  store: Pick<Store, 'audit' | 'kv'>,
  now: Date,
): Promise<boolean> {
  const last = await lastAuditVerification(store.kv)
  if (last.at && now.getTime() - Date.parse(last.at) < DAY_MS) return false
  await recordAuditVerification(store, now)
  return true
}
