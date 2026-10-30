/** Whether a pattern has glob characters. */
export const isGlob = (pattern: string) => /[*?[{]/.test(pattern)

/**
 * Path glob as a regular expression: `*` stays within a segment, `**` crosses them, `?` is one
 * character, `{a,b}` alternatives.
 */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index++
        if (glob[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else if (char === '{') {
      const end = glob.indexOf('}', index)
      if (end < 0) source += '\\{'
      else {
        source += `(?:${glob
          .slice(index + 1, end)
          .split(',')
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'))
          .join('|')})`
        index = end
      }
    } else source += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Whether `path` matches any of `globs`. */
export const matchesAny = (path: string, globs: readonly string[]) =>
  globs.some((glob) => globToRegExp(glob).test(path))

/** The directory part of a glob before its first wildcard segment; for a literal path, its directory. */
export function literalPrefix(glob: string): string {
  const segments = glob.split('/')
  const first = segments.findIndex(isGlob)
  return (first < 0 ? segments.slice(0, -1) : segments.slice(0, first)).join('/')
}
