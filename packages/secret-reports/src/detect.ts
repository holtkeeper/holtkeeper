import type { SecretKind } from './model.ts'

/** Well-known credential shapes; matching any of them means a value slipped into a report. */
const knownShapes: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bhk_mcp_[A-Za-z0-9_-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
]

const candidate = /[A-Za-z0-9+/=_.~-]{20,}/g

const entropy = (text: string) => {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const share = count / text.length
    bits -= share * Math.log2(share)
  }
  return bits
}

/**
 * Long runs that look random: lower case, upper case and digits mixed with high entropy, or 32+
 * hex digits. Words joined by `_`, `-` or `.` (`WIDGET_SERVICE_API_KEY`) do not count.
 */
function looksRandom(run: string) {
  if (/^[0-9a-f]{32,}$/i.test(run)) return true
  const parts = run.split(/[._~-]/)
  if (parts.every((part) => /^[A-Za-z]*$/.test(part) || part.length < 12)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(run)).length
  return classes >= 3 && entropy(run) >= 3.5
}

/**
 * Whether `text` seems to hold a secret value: a well-known credential shape (private keys,
 * cloud, forge and chat tokens, JWTs, URLs with a password) or a long random-looking run. Used on
 * every free-text field of a report, so a report that would expose the secret again is refused
 * before it is stored. It cannot recognize ordinary passwords; the tool description asks agents
 * never to send any value.
 */
export function looksLikeSecret(text: string): boolean {
  if (knownShapes.some((shape) => shape.test(text))) return true
  return [...text.matchAll(candidate)].some(([run]) => looksRandom(run))
}

/** `masked` as the tool accepts it: up to 4 visible characters, an ellipsis and the length. */
export const maskedPattern = /^(?<shown>[^\s…]{0,4})…\((?<length>[1-9]\d{0,4})\)$/

/** Why a mask shows too much of the value, or `undefined` when it is acceptable. */
export function maskProblem(masked: string, kind: SecretKind): string | undefined {
  const match = maskedPattern.exec(masked)
  if (!match?.groups) return 'expected up to 4 characters, "…" and the length, e.g. "ab1…(40)"'
  const shown = (match.groups.shown ?? '').length
  const length = Number(match.groups.length)
  if (kind === 'password' && shown > 0)
    return 'for passwords show no characters at all, only the length, e.g. "…(12)"'
  if (shown > Math.floor(length / 4))
    return `show at most ${Math.floor(length / 4)} characters of a ${length}-character value`
  return undefined
}
