import { type Secret, resolveSecret } from '@holtkeeper/forge'
import * as client from 'openid-client'

import type { OidcProviderOptions } from './options.ts'

/** What Holtkeeper uses from an ID token. */
export interface OidcClaims {
  subject: string
  email?: string
  emailVerified: boolean
  name?: string
  /** `preferred_username` or `nickname`, e.g. the GitLab username. */
  username?: string
}

/** One configured OpenID provider. Implementations must enforce state, nonce and PKCE. */
export interface OidcClient {
  authorizationUrl(input: {
    redirectUri: string
    scope: string
    state: string
    nonce: string
    codeVerifier: string
  }): Promise<URL>
  /** Exchanges the code in `callbackUrl`; throws when the response or the ID token is invalid. */
  callback(input: {
    callbackUrl: URL
    state: string
    nonce: string
    codeVerifier: string
  }): Promise<OidcClaims>
}

export type OidcClientFactory = (options: OidcProviderOptions) => OidcClient

/** `OidcClient` backed by `openid-client`; discovery runs on first use and is retried after failures. */
export const openidClient: OidcClientFactory = (options) => {
  const secret: Secret = options.clientSecret
  let config: Promise<client.Configuration> | undefined
  const configuration = () => {
    config ??= client
      .discovery(new URL(options.issuer), options.clientId, resolveSecret(secret))
      .catch((error: unknown) => {
        config = undefined
        throw error
      })
    return config
  }

  return {
    async authorizationUrl({ redirectUri, scope, state, nonce, codeVerifier }) {
      return client.buildAuthorizationUrl(await configuration(), {
        redirect_uri: redirectUri,
        scope,
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      })
    },
    async callback({ callbackUrl, state, nonce, codeVerifier }) {
      const tokens = await client.authorizationCodeGrant(await configuration(), callbackUrl, {
        expectedState: state,
        expectedNonce: nonce,
        pkceCodeVerifier: codeVerifier,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (!claims) throw new Error('no ID token')
      const email = typeof claims.email === 'string' ? claims.email : undefined
      const verified = claims.email_verified === true || claims.email_verified === 'true'
      return {
        subject: claims.sub,
        email,
        emailVerified: email !== undefined && verified,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        username:
          typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : typeof claims.nickname === 'string'
              ? claims.nickname
              : undefined,
      }
    },
  }
}
