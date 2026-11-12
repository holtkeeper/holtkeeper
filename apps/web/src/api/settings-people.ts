import type { LinkResponse, PeopleSummary } from '@holtkeeper/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { request } from './client.ts'
import { keys } from './queries.ts'

const peopleApi = {
  summary: () => request<PeopleSummary>('GET', '/auth/users/admin/summary'),
  resendInvite: (userId: string) =>
    request<LinkResponse>('POST', `/auth/users/admin/users/${encodeURIComponent(userId)}/invite`),
}

/** The People strip: users per state. */
export const usePeopleSummary = (enabled = true) =>
  useQuery({ queryKey: [...keys.users, 'summary'], queryFn: peopleApi.summary, enabled })

/** A fresh enrollment link for someone who never signed in. */
export function useResendInvite() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: peopleApi.resendInvite,
    onSuccess: () => client.invalidateQueries({ queryKey: keys.users }),
  })
}
