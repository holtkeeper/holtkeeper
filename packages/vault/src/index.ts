import { type Secret, resolveSecret } from '@holtkeeper/forge'

/**
 * Encrypts secrets before they are stored (tokens, API keys). Implementations are interchangeable;
 * a KMS-backed one only needs these two methods.
 */
export interface Vault {
  seal(plaintext: string): Promise<string>
  /** Throws when the value was sealed with another key or was tampered with. */
  open(sealed: string): Promise<string>
}

const VERSION = 'v1'
const encoder = new TextEncoder()

/**
 * AES-256-GCM with a key derived from `secret` by SHA-256. Use at least 32 random characters,
 * e.g. `openssl rand -base64 48`. Sealed values look like `v1.<iv>.<ciphertext>` (base64url).
 */
export function aesVault(secret: Secret): Vault {
  let key: Promise<CryptoKey> | undefined
  const getKey = () => {
    key ??= (async () => {
      const material = resolveSecret(secret)
      if (material.length < 32) throw new Error('vault key must be at least 32 characters')
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material))
      return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
    })()
    return key
  }

  return {
    async seal(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await getKey(),
        encoder.encode(plaintext),
      )
      return [
        VERSION,
        Buffer.from(iv).toString('base64url'),
        Buffer.from(data).toString('base64url'),
      ].join('.')
    },
    async open(sealed) {
      const [version, iv, data] = sealed.split('.')
      if (version !== VERSION || !iv || !data) throw new Error('not a sealed value')
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(iv, 'base64url') },
        await getKey(),
        Buffer.from(data, 'base64url'),
      )
      return new TextDecoder().decode(plain)
    },
  }
}
