/** A fresh webhook secret: 32 random bytes from `crypto.getRandomValues`, base64url without padding. */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString('base64url')
}
