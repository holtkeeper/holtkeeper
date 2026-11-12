/**
 * `GET /auth/users/admin/summary` — the People strip over the users the caller may see.
 * `invited` counts enabled users with a pending enrollment link (live or expired) who never signed
 * in, `active` the other enabled ones, `withoutSignIn` enabled users with neither a passkey nor a
 * linked identity, `admins` enabled users holding `*` on every repository.
 */
export interface PeopleSummary {
  total: number
  active: number
  invited: number
  disabled: number
  admins: number
  withoutSignIn: number
  /** Sign-in methods the instance offers: `passkeys`, then each OIDC provider id. */
  signIn: string[]
}
