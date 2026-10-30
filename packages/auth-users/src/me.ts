import type { Principal } from '@holtkeeper/access'
import type { User } from '@holtkeeper/store'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server'
import { z } from 'zod'

import type { Context } from './context.ts'
import { HttpError } from './errors.ts'
import type { registerBody } from './passkeys.ts'
import { toBase64Url } from './tokens.ts'

export const renamePasskeySchema = z.object({ label: z.string().trim().min(1).max(100) })

const encoder = new TextEncoder()

/** The signed-in principal's own user record. */
export async function selfUser(ctx: Context, principal: Principal | undefined): Promise<User> {
  const user = principal && (await ctx.store.getUser(principal.id))
  if (!user || user.disabled) throw new HttpError(401, 'not signed in')
  return user
}

/** Registration options for another passkey of a signed-in user; the challenge is bound to them. */
export async function addPasskeyOptions(
  ctx: Context,
  user: User,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; cookie: string }> {
  const existing = await ctx.store.listPasskeys(user.id)
  const options = await ctx.webauthn.registrationOptions({
    rpName: ctx.rpName,
    rpID: ctx.rpID,
    userID: encoder.encode(user.id),
    userName: user.email ?? user.name,
    userDisplayName: user.name,
    exclude: existing.map(({ id, transports }) => ({ id, transports })),
  })
  const cookie = await ctx.challenges.issue({ c: options.challenge, k: 'add', t: user.id })
  return { options, cookie }
}

/** Stores the passkey from a valid registration started by `addPasskeyOptions`. */
export async function addPasskey(
  ctx: Context,
  request: Request,
  user: User,
  body: z.infer<typeof registerBody>,
): Promise<void> {
  const challenge = await ctx.challenges.read(request)
  if (challenge?.k !== 'add' || challenge.t !== user.id) {
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

  const now = ctx.now().toISOString()
  await ctx.store.putPasskey({
    id: credential.id,
    userId: user.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    label: body.label,
    createdAt: now,
  })
  await ctx.log(user.id, 'passkey.registered', user.id, { passkey: credential.id, purpose: 'add' })
}

async function ownPasskey(ctx: Context, user: User, passkeyId: string) {
  const passkey = await ctx.store.getPasskey(passkeyId)
  if (passkey?.userId !== user.id) throw new HttpError(404, 'passkey not found')
  return passkey
}

export async function renamePasskey(
  ctx: Context,
  user: User,
  passkeyId: string,
  { label }: z.infer<typeof renamePasskeySchema>,
): Promise<void> {
  const passkey = await ownPasskey(ctx, user, passkeyId)
  await ctx.store.putPasskey({ ...passkey, label })
  await ctx.log(user.id, 'passkey.renamed', user.id, { passkey: passkey.id })
}

/** Removes one of the user's passkeys, never the last one: that would lock them out. */
export async function removeOwnPasskey(ctx: Context, user: User, passkeyId: string) {
  const passkey = await ownPasskey(ctx, user, passkeyId)
  if ((await ctx.store.listPasskeys(user.id)).length <= 1) {
    throw new HttpError(409, 'cannot remove your only passkey')
  }
  await ctx.store.removePasskey(passkey.id)
  await ctx.log(user.id, 'passkey.removed', user.id, { passkey: passkey.id })
}
