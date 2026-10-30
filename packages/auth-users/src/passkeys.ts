import type { User } from '@holtkeeper/store'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'
import { z } from 'zod'

import type { Context } from './context.ts'
import { HttpError } from './errors.ts'
import { markLinkUsed, openLink } from './links.ts'
import { fromBase64Url, toBase64Url } from './tokens.ts'
import { type CredentialResponse, credentialResponse } from './webauthn.ts'

export const loginBody = z.object({ response: credentialResponse })
export const registerBody = z.object({
  response: credentialResponse,
  label: z.string().trim().min(1).max(100).optional(),
})

const encoder = new TextEncoder()

/** Options for a discoverable-credential login; the challenge goes into a short-lived cookie. */
export async function loginOptions(
  ctx: Context,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; cookie: string }> {
  const options = await ctx.webauthn.authenticationOptions({ rpID: ctx.rpID })
  return { options, cookie: await ctx.challenges.issue({ c: options.challenge, k: 'login' }) }
}

/** The user behind a valid login assertion; updates the passkey's counter and last use. */
export async function verifyLogin(
  ctx: Context,
  request: Request,
  response: CredentialResponse,
): Promise<User> {
  const challenge = await ctx.challenges.read(request)
  if (challenge?.k !== 'login') throw new HttpError(400, 'login challenge missing or expired')
  const passkey = await ctx.store.getPasskey(response.id)
  const user = passkey && (await ctx.store.getUser(passkey.userId))
  if (!passkey || !user) throw new HttpError(401, 'unknown passkey')
  const { userHandle } = response.response
  if (typeof userHandle === 'string' && userHandle !== toBase64Url(encoder.encode(user.id))) {
    throw new HttpError(401, 'passkey does not belong to this account')
  }
  if (user.disabled) throw new HttpError(403, 'account is disabled')

  const result = await ctx.webauthn.verifyAuthentication(
    response,
    { challenge: challenge.c, origin: ctx.origin, rpID: ctx.rpID },
    {
      id: passkey.id,
      publicKey: fromBase64Url(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports,
    },
  )
  if (!result) throw new HttpError(401, 'passkey verification failed')

  await ctx.store.putPasskey({
    ...passkey,
    counter: result.newCounter,
    lastUsedAt: ctx.now().toISOString(),
  })
  await ctx.log(user.id, 'user.login', user.id, { method: 'passkey', passkey: passkey.id })
  return user
}

/** Registration options for the holder of a setup or recovery link. */
export async function registrationOptions(
  ctx: Context,
  token: string,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; cookie: string }> {
  const { link, user } = await openLink(ctx.store, token, ctx.now())
  const existing = await ctx.store.listPasskeys(user.id)
  const options = await ctx.webauthn.registrationOptions({
    rpName: ctx.rpName,
    rpID: ctx.rpID,
    userID: encoder.encode(user.id),
    userName: user.email ?? user.name,
    userDisplayName: user.name,
    exclude: existing.map(({ id, transports }) => ({ id, transports })),
  })
  const cookie = await ctx.challenges.issue({
    c: options.challenge,
    k: 'register',
    t: link.tokenHash,
  })
  return { options, cookie }
}

/**
 * Stores the passkey from a valid registration and consumes the link. A recovery link also bumps
 * the user's session version. Returns the user as stored afterwards.
 */
export async function verifyRegistration(
  ctx: Context,
  request: Request,
  token: string,
  body: z.infer<typeof registerBody>,
): Promise<User> {
  const now = ctx.now()
  const { link, user } = await openLink(ctx.store, token, now)
  const challenge = await ctx.challenges.read(request)
  if (challenge?.k !== 'register' || challenge.t !== link.tokenHash) {
    throw new HttpError(400, 'registration challenge missing or expired')
  }
  const credential = await ctx.webauthn.verifyRegistration(body.response, {
    challenge: challenge.c,
    origin: ctx.origin,
    rpID: ctx.rpID,
  })
  if (!credential) throw new HttpError(400, 'passkey registration failed')
  if (await ctx.store.getPasskey(credential.id))
    throw new HttpError(409, 'passkey is already registered')

  await markLinkUsed(ctx.store, link, now)
  await ctx.store.putPasskey({
    id: credential.id,
    userId: user.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    label: body.label,
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
  })
  const updated =
    link.purpose === 'recover' ? { ...user, sessionVersion: user.sessionVersion + 1 } : user
  if (updated !== user) await ctx.store.putUser(updated)

  await ctx.log(user.id, 'passkey.registered', user.id, {
    passkey: credential.id,
    purpose: link.purpose,
  })
  if (link.purpose === 'recover') await ctx.log(user.id, 'user.recovered', user.id)
  await ctx.log(user.id, 'user.login', user.id, { method: link.purpose })
  return updated
}
