const markupFile = /\.(svg|xml|html?|xhtml)$/i
const minLength = 120
const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+/g

/** Whether a file's long lines may be shown formatted by {@link formatMarkupLine}. */
export const isMarkupFile = (file: string): boolean => markupFile.test(file)

type Kind = 'open' | 'close' | 'single' | 'text'

function kindOf(part: string): Kind {
  if (!part.startsWith('<')) return 'text'
  if (part.startsWith('</')) return 'close'
  if (part.startsWith('<!') || part.startsWith('<?') || part.endsWith('/>')) return 'single'
  return 'open'
}

/**
 * A long single line of markup from an SVG, XML or HTML file split into indented lines for reading,
 * or undefined when the line should be shown as is. Display only: joining the result does not
 * reproduce the input.
 */
export function formatMarkupLine(file: string, line: string): string[] | undefined {
  const text = line.trim()
  if (!isMarkupFile(file) || text.length < minLength || !text.startsWith('<')) return undefined
  const parts = (text.match(token) ?? [])
    .map((part) => (part.startsWith('<') ? part : part.trim()))
    .filter(Boolean)
  if (parts.length < 3) return undefined
  const kinds = parts.map(kindOf)
  const lines: string[] = []
  let depth = 0
  for (let i = 0; i < parts.length; i++) {
    const kind = kinds[i]!
    const pad = '  '.repeat(depth)
    if (kind === 'close') {
      depth = Math.max(0, depth - 1)
      lines.push('  '.repeat(depth) + parts[i])
    } else if (kind === 'open' && kinds[i + 1] === 'close') {
      lines.push(pad + parts[i] + parts[++i])
    } else if (kind === 'open' && kinds[i + 1] === 'text' && kinds[i + 2] === 'close') {
      lines.push(pad + parts[i] + parts[i + 1] + parts[i + 2])
      i += 2
    } else {
      lines.push(pad + parts[i])
      if (kind === 'open') depth++
    }
  }
  return lines.length > 1 ? lines : undefined
}
