import type { Grant, Principal } from '@holtkeeper/access'
import { type AuthProvider, safeEqual } from '@holtkeeper/auth'
import { type Secret, resolveSecret } from '@holtkeeper/forge'

/** What the proxy said about the user. */
export interface HeaderIdentity {
  user: string
  name?: string
  email?: string
  groups: string[]
}

export interface HeaderAuthOptions {
  /** Header with the unique user id. Default `x-forwarded-user`. */
  userHeader?: string
  /** Default `x-forwarded-preferred-username`; falls back to the user id. */
  nameHeader?: string
  /** Default `x-forwarded-email`. */
  emailHeader?: string
  /** Default `x-forwarded-groups`. */
  groupsHeader?: string
  /** Separator of the groups header. Default `,`. */
  groupsSeparator?: string
  /**
   * A header the proxy adds with a shared secret. Requests without it are anonymous, which stops
   * anyone who reaches Holtkeeper around the proxy from claiming an identity.
   */
  proxySecret?: { header: string; value: Secret }
  /** Grants per proxy group; a user gets the grants of every group they are in. */
  roles?: Record<string, Grant[]>
  /** Grants for every identified user on top of their roles. Default none. */
  defaultGrants?: Grant[]
  /** Full control over grants; replaces `roles` and `defaultGrants` when given. */
  grants?: (identity: HeaderIdentity) => Grant[]
}

/**
 * Trusts identity headers set by an authenticating reverse proxy (oauth2-proxy, Authelia,
 * Pomerium, Cloudflare Access, ...). The proxy must strip these headers from client requests.
 */
export function headerAuth(options: HeaderAuthOptions = {}): AuthProvider {
  const {
    userHeader = 'x-forwarded-user',
    nameHeader = 'x-forwarded-preferred-username',
    emailHeader = 'x-forwarded-email',
    groupsHeader = 'x-forwarded-groups',
    groupsSeparator = ',',
    proxySecret,
    roles = {},
    defaultGrants = [],
  } = options
  const grantsFor =
    options.grants ??
    ((identity: HeaderIdentity) => [
      ...defaultGrants,
      ...identity.groups.flatMap((group) => roles[group] ?? []),
    ])

  return {
    name: 'header',
    async authenticate(request): Promise<Principal | undefined> {
      if (
        proxySecret &&
        !safeEqual(request.headers.get(proxySecret.header) ?? '', resolveSecret(proxySecret.value))
      ) {
        return undefined
      }
      const user = request.headers.get(userHeader)?.trim()
      if (!user) return undefined

      const email = request.headers.get(emailHeader)?.trim() || undefined
      const identity: HeaderIdentity = {
        user,
        name: request.headers.get(nameHeader)?.trim() || undefined,
        email,
        groups: (request.headers.get(groupsHeader) ?? '')
          .split(groupsSeparator)
          .map((group) => group.trim())
          .filter(Boolean),
      }
      return {
        id: `header:${user}`,
        name: identity.name ?? user,
        ...(email ? { email } : {}),
        provider: 'header',
        grants: grantsFor(identity),
      }
    },
    info: () => ({ provider: 'header', methods: [] }),
  }
}
