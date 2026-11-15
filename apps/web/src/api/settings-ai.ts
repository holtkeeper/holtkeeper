import type {
  AgentToolList,
  AiBudgetOverview,
  EmbeddingModelList,
  IntegrationForgeList,
  KnowledgeEmbeddingsStatus,
  WebhookReenableResult,
} from '@holtkeeper/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { request } from './client.ts'
import { api } from './endpoints.ts'
import { keys } from './queries.ts'

/** Endpoints of Settings › AI and Settings › Integrations. */
const aiSettingsApi = {
  budget: () => request<AiBudgetOverview>('GET', '/api/ai/budget'),
  tools: () => request<AgentToolList>('GET', '/api/ai/tools'),
  forges: () => request<IntegrationForgeList>('GET', '/api/integrations/forges'),
  reenableWebhooks: (forge: string) =>
    request<WebhookReenableResult>(
      'POST',
      `/api/integrations/forges/${encodeURIComponent(forge)}/webhooks/reenable`,
    ),
  embeddings: () => request<KnowledgeEmbeddingsStatus>('GET', '/api/knowledge/embeddings'),
  embeddingModels: (credential: string) =>
    request<EmbeddingModelList>(
      'GET',
      `/api/knowledge/embeddings/models${credential ? `?credential=${encodeURIComponent(credential)}` : ''}`,
    ),
  reindexEmbeddings: () =>
    request<KnowledgeEmbeddingsStatus>('POST', '/api/knowledge/embeddings/reindex'),
}

const embeddingsKey = [...keys.ai, 'embeddings'] as const

/** Where semantic search indexing stands; polled every few seconds while it indexes. */
export const useKnowledgeEmbeddings = (enabled = true) =>
  useQuery({
    queryKey: embeddingsKey,
    queryFn: aiSettingsApi.embeddings,
    enabled,
    refetchInterval: (query) => (query.state.data?.state === 'indexing' ? 5000 : false),
  })

/**
 * Embedding models of an `ai-sdk` credential (id or name; empty for the one the setting or
 * `llm.provider` names); needs a global `settings:write`.
 */
export const useEmbeddingModels = (credential: string, enabled = true) =>
  useQuery({
    queryKey: [...embeddingsKey, 'models', credential],
    queryFn: () => aiSettingsApi.embeddingModels(credential),
    enabled,
    staleTime: 5 * 60_000,
  })

/** Drops every knowledge vector and embeds the notes again. */
export function useReindexEmbeddings() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: aiSettingsApi.reindexEmbeddings,
    onSuccess: (status) => client.setQueryData(embeddingsKey, status),
  })
}

/** This week's budget with the spend per feature and per scoped cap. */
export const useAiBudget = (enabled = true) =>
  useQuery({ queryKey: [...keys.ai, 'budget'], queryFn: aiSettingsApi.budget, enabled })

/** The tools agents may call, read-only. */
export const useAgentTools = (enabled = true) =>
  useQuery({ queryKey: [...keys.ai, 'tools'], queryFn: aiSettingsApi.tools, enabled })

/** Panel forges with their repository counts, last webhook delivery and webhook health. */
export const useIntegrationForges = (enabled = true) =>
  useQuery({
    queryKey: [...keys.config, 'integration-forges'],
    queryFn: aiSettingsApi.forges,
    enabled,
  })

/** Checks a forge's webhooks now and re-enables those GitLab disabled. */
export function useReenableForgeWebhooks() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: aiSettingsApi.reenableWebhooks,
    onSuccess: () => client.invalidateQueries({ queryKey: [...keys.config, 'integration-forges'] }),
  })
}

/** This week's AI usage per provider credential name, from `from` (the week start) on. */
export const useWeekUsageByProvider = (from: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...keys.ai, 'usage', { groupBy: 'provider', from }],
    queryFn: () => api.aiUsage({ groupBy: 'provider', from: from ?? '' }),
    enabled: enabled && from !== undefined,
  })
