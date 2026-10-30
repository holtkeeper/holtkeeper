import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { z } from 'zod'

/** The JSON a browser sends after `navigator.credentials.create()` or `.get()`, loosely checked. */
export const credentialResponse = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string() }),
  clientExtensionResults: z.looseObject({}).default({}),
})

export type CredentialResponse = z.infer<typeof credentialResponse>

// The library re-validates every field it reads, so the loose shape is enough to hand it over.
function asRegistration(response: CredentialResponse): RegistrationResponseJSON {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return response as unknown as RegistrationResponseJSON
}

function asAuthentication(response: CredentialResponse): AuthenticationResponseJSON {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return response as unknown as AuthenticationResponseJSON
}

/** A credential as WebAuthn verification needs it. */
interface Credential {
  id: string
  publicKey: Uint8Array<ArrayBuffer>
  counter: number
  transports?: string[]
}

interface Expected {
  challenge: string
  origin: string
  rpID: string
}

/**
 * The WebAuthn operations the flows use. Verification returns `undefined` for any response that
 * does not check out, never throws for bad input.
 */
export interface WebAuthn {
  registrationOptions(input: {
    rpName: string
    rpID: string
    userID: Uint8Array<ArrayBuffer>
    userName: string
    userDisplayName: string
    exclude: { id: string; transports?: string[] }[]
  }): Promise<PublicKeyCredentialCreationOptionsJSON>
  authenticationOptions(input: { rpID: string }): Promise<PublicKeyCredentialRequestOptionsJSON>
  verifyRegistration(
    response: CredentialResponse,
    expected: Expected,
  ): Promise<Credential | undefined>
  verifyAuthentication(
    response: CredentialResponse,
    expected: Expected,
    credential: Credential,
  ): Promise<{ newCounter: number } | undefined>
}

/** `WebAuthn` backed by `@simplewebauthn/server`; user verification is required. */
export const simpleWebAuthn = (): WebAuthn => ({
  registrationOptions: (input) =>
    generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpID,
      userID: input.userID,
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      attestationType: 'none',
      excludeCredentials: input.exclude,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    }),
  authenticationOptions: ({ rpID }) =>
    generateAuthenticationOptions({ rpID, userVerification: 'required' }),
  async verifyRegistration(response, expected) {
    try {
      const result = await verifyRegistrationResponse({
        response: asRegistration(response),
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.origin,
        expectedRPID: expected.rpID,
        requireUserVerification: true,
      })
      if (!result.verified) return undefined
      const { credential } = result.registrationInfo
      return {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
      }
    } catch {
      return undefined
    }
  },
  async verifyAuthentication(response, expected, credential) {
    try {
      const result = await verifyAuthenticationResponse({
        response: asAuthentication(response),
        expectedChallenge: expected.challenge,
        expectedOrigin: expected.origin,
        expectedRPID: expected.rpID,
        credential,
        requireUserVerification: true,
      })
      return result.verified ? { newCounter: result.authenticationInfo.newCounter } : undefined
    } catch {
      return undefined
    }
  },
})
