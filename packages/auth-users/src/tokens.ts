import { createHash } from 'node:crypto'

/** 32 random bytes, base64url. */
export const randomToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

/** SHA-256 of `token`, base64url. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url')

export const looksLikeToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token)

export const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

export const fromBase64Url = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'))
