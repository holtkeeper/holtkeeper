import type { AgentToolList, AiBudgetOverview, IntegrationForgeList } from '@holtkeeper/api'
import { useQuery } from '@tanstack/react-query'

import { request } from './client.ts'
import { api } from './endpoints.ts'
import { keys } from './queries.ts'

/** Endpoints of Settings › AI and Settings › Integrations. */
const aiSettingsApi = {
  budget: () => request<AiBudgetOverview>('GET', '/api/ai/budget'),
  tools: () => request<AgentToolList>('GET', '/api/ai/tools'),
  forges: () => request<IntegrationForgeList>('GET', '/api/integrations/forges'),
}

/** This week's budget with the spend per feature and per scoped cap. */
export const useAiBudget = (enabled = true) =>
  useQuery({ queryKey: [...keys.ai, 'budget'], queryFn: aiSettingsApi.budget, enabled })

/** The tools agents may call, read-only. */
export const useAgentTools = (enabled = true) =>
  useQuery({ queryKey: [...keys.ai, 'tools'], queryFn: aiSettingsApi.tools, enabled })

/** Panel forges with their repository counts and last webhook delivery. */
export const useIntegrationForges = (enabled = true) =>
  useQuery({
    queryKey: [...keys.config, 'integration-forges'],
    queryFn: aiSettingsApi.forges,
    enabled,
  })

/** This week's AI usage per provider credential name, from `from` (the week start) on. */
export const useWeekUsageByProvider = (from: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...keys.ai, 'usage', { groupBy: 'provider', from }],
    queryFn: () => api.aiUsage({ groupBy: 'provider', from: from ?? '' }),
    enabled: enabled && from !== undefined,
  })
