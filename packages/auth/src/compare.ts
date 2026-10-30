import { timingSafeEqual } from 'node:crypto'

/** Compares two secrets in constant time, regardless of their lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = new Bun.CryptoHasher('sha256').update(a).digest()
  const right = new Bun.CryptoHasher('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}
