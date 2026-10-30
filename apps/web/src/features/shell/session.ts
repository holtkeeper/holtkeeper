import type { Action, AuthInfo, Principal } from '@holtkeeper/api'
import { createContext, use } from 'react'

import { can } from '../../lib/access.ts'

/** The signed-in principal and the auth provider's info, available below the app shell. */
export interface Session {
  principal: Principal
  auth: AuthInfo
}

export const SessionContext = createContext<Session | null>(null)

/** The current session; only valid inside the signed-in app shell. */
export function useSession(): Session & { can: (action: Action) => boolean } {
  const session = use(SessionContext)
  if (!session) throw new Error('useSession must be used inside the app shell')
  return { ...session, can: (action) => can(session.principal, action) }
}
