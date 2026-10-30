import type { Principal } from '@holtkeeper/access'

/** A way to sign in that the web UI can offer. */
export type LoginMethod =
  | { kind: 'password' }
  | { kind: 'passkey' }
  | { kind: 'oidc'; id: string; label: string; url: string }

/** What the UI needs to know about the active provider. */
export interface AuthInfo {
  provider: string
  /** Empty when sign-in happens outside Holtkeeper (no auth, trusted proxy headers). */
  methods: LoginMethod[]
  /** `POST` here to sign out; absent when the provider has no sessions. */
  logoutUrl?: string
}

/**
 * Decides who a request comes from. The server asks exactly one provider per request; providers
 * are interchangeable as long as they implement this interface.
 */
export interface AuthProvider {
  /** Unique name; the provider's own endpoints live under `/auth/<name>/`. */
  readonly name: string
  /** The principal behind the request, or `undefined` for anonymous requests. */
  authenticate(request: Request): Promise<Principal | undefined>
  /**
   * Serves the provider's endpoints. `path` is the part after `/auth/<name>`, starting with `/`.
   * `principal` is the already authenticated caller, if any. Returns `undefined` for unknown paths.
   */
  handle?(
    request: Request,
    path: string,
    principal: Principal | undefined,
  ): Promise<Response | undefined>
  info(): AuthInfo
  /**
   * Called once when the server starts. Returns lines for the server log, e.g. a first-admin
   * setup link.
   */
  start?(): Promise<string[]>
}
