/** A fingerprint as reports carry it: the first 16 hex characters of a SHA-256. */
export const fingerprintPattern = /^[0-9a-f]{16}$/

/**
 * The first 16 hex characters of the SHA-256 of `value` exactly as given (no trimming), the same
 * as `printf %s "$VALUE" | shasum -a 256 | cut -c1-16`. Enough to tell whether a reported secret
 * is one of the organization's without revealing it: the value of a random key cannot be guessed
 * back from it. Short passwords can be, which is why reports refuse fingerprints of passwords.
 */
export async function secretFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
