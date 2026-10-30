import type { RepoRef } from '@holtkeeper/forge'

/** FNV-1a hash of `text`, for stable colors. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

const letter = (segment: string | undefined) =>
  (segment?.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase()

/**
 * Two letters for a repository: the first of its parent and of its name (`data-tools/dealer-frontend`
 * → `DD`), or the first two words of the name for a top-level repository.
 */
export function repoInitials(path: string): string {
  const segments = path.split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  if (segments.length > 1) return `${letter(segments.at(-2))}${letter(name)}` || '?'
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (
    (words.length > 1
      ? `${letter(words[0])}${letter(words[1])}`
      : name.slice(0, 2).toUpperCase()) || '?'
  )
}

/**
 * A generated avatar: the repository's initials on a diagonal two-tone gradient whose hue comes
 * from its full path, so siblings with the same initials still look different.
 */
export function generatedRepoAvatar(repo: RepoRef): string {
  const seed = hash(`${repo.forge}:${repo.path}`)
  const hue = seed % 360
  const shift = 25 + ((seed >>> 9) % 30)
  const id = `g${seed.toString(36)}`
  const initials = repoInitials(repo.path).replace(/[<>&"']/g, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 58%)"/><stop offset="1" stop-color="hsl(${(hue + shift) % 360} 72% 42%)"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#${id})"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif,system-ui,sans-serif" font-size="26" font-weight="650" fill="#fff" letter-spacing="0.5">${initials}</text></svg>`
}
