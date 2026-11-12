import type { LimitUsageList } from '@holtkeeper/api'
import { useQuery } from '@tanstack/react-query'

import { request } from './client.ts'
import { keys } from './queries.ts'

/** Live request-limit usage of every credential, refreshed every 15 seconds. */
export const useLimitUsage = (enabled = true) =>
  useQuery({
    queryKey: [...keys.config, 'limit-usage'],
    queryFn: () => request<LimitUsageList>('GET', '/api/limits/usage'),
    refetchInterval: 15_000,
    enabled,
  })
