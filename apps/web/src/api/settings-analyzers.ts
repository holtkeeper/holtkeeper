import type {
  AnalyzerHealthList,
  CommitConventionsCheckInput,
  CommitConventionsCheckResult,
  PolicyDraftInput,
  PolicyDraftResult,
} from '@holtkeeper/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { request } from './client.ts'
import { keys } from './queries.ts'

/** Endpoints of Settings › Analyzers and Settings › Policies. */
const analyzersApi = {
  health: () => request<AnalyzerHealthList>('GET', '/api/jobs/analyzers/health'),
  saveDraft: (input: PolicyDraftInput) =>
    request<PolicyDraftResult>('POST', '/api/settings/draft', { body: input }),
  checkCommit: (input: CommitConventionsCheckInput) =>
    request<CommitConventionsCheckResult>('POST', '/api/commit-conventions/check', {
      body: input,
    }),
}

/** Jobs of the last seven days per analyzer. */
export const useAnalyzerHealth = (enabled = true) =>
  useQuery({
    queryKey: [...keys.jobs, 'analyzers', 'health'],
    queryFn: analyzersApi.health,
    enabled,
  })

/** Saves a policy draft of several setting changes at once; refreshes settings. */
export function useSavePolicyDraft() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: analyzersApi.saveDraft,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.settings }),
  })
}

/** Checks a commit message or branch name against a repository's conventions. */
export const useCheckCommitConventions = () => useMutation({ mutationFn: analyzersApi.checkCommit })
