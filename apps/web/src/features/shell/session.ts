import type { Action, AuthInfo, CrossTeamLevel, MePrincipal } from '@holtkeeper/api'
import { createContext, use } from 'react'

import { can, canGlobal } from '../../lib/access.ts'

/** The signed-in principal and the auth provider's info, available below the app shell. */
export interface Session {
  principal: MePrincipal
  auth: AuthInfo
  /** The `access.crossTeam` level, for what the catalog pages show. */
  crossTeam: CrossTeamLevel
}

export const SessionContext = createContext<Session | null>(null)

/**
 * The current session; only valid inside the signed-in app shell. `can` ignores scopes,
 * `canGlobal` needs a grant over everything (see `lib/access.ts`).
 */
export function useSession(): Session & {
  can: (action: Action) => boolean
  canGlobal: (action: Action) => boolean
} {
  const session = use(SessionContext)
  if (!session) throw new Error('useSession must be used inside the app shell')
  return {
    ...session,
    can: (action) => can(session.principal, action),
    canGlobal: (action) => canGlobal(session.principal, action),
  }
}
