import { rootPrincipal } from '@holtkeeper/access'
import type { AuthProvider } from '@holtkeeper/auth'

export interface NoAuthOptions {
  /** Display name of the single user. Default `root`. */
  name?: string
}

/**
 * No sign-in: every request is the root user with full access. For local use and setups protected
 * entirely by the network; never expose it publicly.
 */
export function noAuth({ name = 'root' }: NoAuthOptions = {}): AuthProvider {
  const principal = rootPrincipal('none', name)
  return {
    name: 'none',
    authenticate: async () => principal,
    info: () => ({ provider: 'none', methods: [] }),
  }
}
