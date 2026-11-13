/** Two views of Go source with the same length and line breaks as the original. */
export interface GoMasks {
  /** Strings, runes and comments blanked (quotes kept): for structure. */
  structure: string
  /** Only comments blanked: for signatures and import paths. */
  code: string
}

const blank = (target: string[], from: number, to: number) => {
  for (let k = from; k < to; k++) if (target[k] !== '\n') target[k] = ' '
}

/**
 * Blanks comments, and in `structure` also the contents of strings and runes, with spaces, so
 * offsets, lines and columns stay those of `source`.
 */
export function mask(source: string): GoMasks {
  const structure = source.split('')
  const code = source.split('')
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    let end = i + 1
    if (char === '/' && next === '/') {
      end = source.indexOf('\n', i)
      if (end < 0) end = source.length
      blank(structure, i, end)
      blank(code, i, end)
    } else if (char === '/' && next === '*') {
      end = source.indexOf('*/', i + 2)
      end = end < 0 ? source.length : end + 2
      blank(structure, i, end)
      blank(code, i, end)
    } else if (char === '"' || char === "'") {
      end = i + 1
      while (end < source.length && source[end] !== char && source[end] !== '\n')
        end += source[end] === '\\' ? 2 : 1
      end = Math.min(end + 1, source.length)
      blank(structure, i + 1, end - 1)
    } else if (char === '`') {
      end = source.indexOf('`', i + 1)
      end = end < 0 ? source.length : end + 1
      blank(structure, i + 1, end - 1)
    }
    i = end
  }
  return { structure: structure.join(''), code: code.join('') }
}

/** Net bracket depth change of a masked line. */
export const depthDelta = (line: string) => {
  let delta = 0
  for (const char of line) {
    if (char === '(' || char === '[' || char === '{') delta++
    else if (char === ')' || char === ']' || char === '}') delta--
  }
  return delta
}
