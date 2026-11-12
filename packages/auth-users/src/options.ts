import type { Grant } from '@holtkeeper/access'
import type { Secret } from '@holtkeeper/forge'
import type { AuditStore, ExternalAccountStore, KvStore, UserStore } from '@holtkeeper/store'

/** One OpenID Connect provider users can sign in with. */
export interface OidcProviderOptions {
  /** Stable id used in URLs and stored identities; changing it orphans linked identities. */
  id: string
  /** Button text in the web UI. */
  label: string
  /** Issuer URL; its discovery document is fetched on first use. */
  issuer: string
  clientId: string
  clientSecret: Secret
  /** Default `['openid', 'email', 'profile']`. */
  scopes?: string[]
  /** Create accounts for unknown people who sign in. Default false. */
  allowSignup?: boolean
  /** Only people with a verified email in one of these domains may sign up. */
  emailDomains?: string[]
  /** Grants of accounts created by sign-up. Default none. */
  defaultGrants?: Grant[]
  /**
   * External account provider the subject belongs to, e.g. `gitlab:work`: every sign-in links
   * the subject to the user as a verified (`oidc`) external account. Default: `gitlab:<id>` of the
   * entry in `forges` whose URL matches the issuer.
   */
  linkAccounts?: string
}

/** A forge OIDC issuers are matched against; usually the forges of the config. */
export interface ForgeIssuer {
  id: string
  kind: string
  url: string
}

/** Configuration of `usersAuth`. */
export interface UsersAuthOptions {
  store: UserStore
  /**
   * The server's key-value store (`store.kv`). With it, `UserView.invite` tracks enrollment links
   * (`users:invite:<id>`) and `UserView.teams` honours the home groups people picked
   * (`prefs:<id>`); without it there are no invite states and teams come from grants.
   */
  kv?: Pick<KvStore, 'get' | 'set'>
  /**
   * Receives sign-ins and what users change about themselves (`user.*`, `passkey.*`,
   * `identity.*`, `account.linked`) when given. Admin changes are audited by the server's
   * middleware around the request instead.
   */
  audit?: Pick<AuditStore, 'append'>
  /** Signs session and flow cookies; at least 32 characters. */
  sessionSecret: Secret
  /**
   * Public origin of the web UI, e.g. `https://keeper.example.com`. Its hostname is the WebAuthn
   * relying party id; setup links are `${origin}/link/<token>`.
   */
  origin: string
  /** Relying party name shown by authenticators. Default `Holtkeeper`. */
  rpName?: string
  /** Default 12. */
  sessionTtlHours?: number
  /** Lifetime of invite and recovery links. Default 72. */
  linkTtlHours?: number
  /** Default true when `origin` is https. */
  secureCookies?: boolean
  oidc?: OidcProviderOptions[]
  /** External accounts; enables the admin linking routes and OIDC auto-linking. */
  externalAccounts?: ExternalAccountStore
  /**
   * Forges whose instance is also an OIDC issuer here. A GitLab issuer at a forge's URL links the
   * signed-in subject (GitLab's numeric user id) as `gitlab:<forge id>`.
   */
  forges?: ForgeIssuer[]
  /** When given, `start()` creates this first admin in an empty store and logs its setup link. */
  bootstrap?: { name: string; email?: string }
  now?: () => Date
}
