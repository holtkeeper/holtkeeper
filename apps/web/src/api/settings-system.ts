import type { AuditVerifyLast, HistorySummary, SystemHealth } from '@holtkeeper/api'
import { useQuery } from '@tanstack/react-query'

import { request } from './client.ts'
import type { HistoryQuery } from './endpoints.ts'
import { keys } from './queries.ts'

/** Endpoints of Settings › System and Settings › Audit log. */
const systemApi = {
  health: () => request<SystemHealth>('GET', '/api/system/health'),
  historySummary: (filter: HistoryQuery) =>
    request<HistorySummary>('GET', '/api/history/summary', { query: { ...filter } }),
  lastVerify: () => request<AuditVerifyLast>('GET', '/api/audit/verify/last'),
}

/** Settings › System at a glance; needs a global `settings:read`. */
export const useSystemHealth = (enabled = true) =>
  useQuery({ queryKey: ['system', 'health'], queryFn: systemApi.health, enabled })

/** Counts of the audit events the caller may see by day, action, actor and repository. */
export const useHistorySummary = (filter: HistoryQuery, enabled = true) =>
  useQuery({
    queryKey: [...keys.history, 'summary', filter],
    queryFn: () => systemApi.historySummary(filter),
    enabled,
  })

/** The newest daily check of the audit chain; needs a global `audit:read`. */
export const useLastAuditVerify = (enabled = true) =>
  useQuery({
    queryKey: [...keys.history, 'verify', 'last'],
    queryFn: systemApi.lastVerify,
    enabled,
  })
