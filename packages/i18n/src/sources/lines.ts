/** Lines an entry occupies in a line-based catalog (1-based, inclusive). */
export interface LineSpan {
  key: string
  start: number
  end: number
}

interface Block {
  key: string
  lines: string[]
}

const newlineOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

/**
 * Inserts blocks of lines next to the nearest sibling in `order`: after the closest preceding key
 * the file has, else before the closest following one, else at the end. `gap` separates blocks
 * with a blank line, as gettext entries are.
 */
export function insertBlocks(
  text: string,
  blocks: readonly Block[],
  order: readonly string[],
  spansOf: (text: string) => LineSpan[],
  gap: boolean,
): string {
  const newline = newlineOf(text)
  let result = text
  for (const block of blocks) {
    const spans = spansOf(result)
    const byKey = new Map(spans.map((span) => [span.key, span]))
    if (byKey.has(block.key)) continue
    const lines = result.split(/\r?\n/)
    const trailing = lines.at(-1) === ''
    if (trailing) lines.pop()
    const position = order.indexOf(block.key)
    let after: LineSpan | undefined
    let before: LineSpan | undefined
    if (position !== -1) {
      for (let i = position - 1; i >= 0 && !after; i--) after = byKey.get(order[i]!)
      if (!after)
        for (let i = position + 1; i < order.length && !before; i++) before = byKey.get(order[i]!)
    }
    if (!after && !before) after = spans.at(-1)
    if (after) {
      const at = after.end
      lines.splice(at, 0, ...(gap ? ['', ...block.lines] : block.lines))
    } else if (before) {
      lines.splice(before.start - 1, 0, ...(gap ? [...block.lines, ''] : block.lines))
    } else {
      if (gap && lines.length && lines.at(-1) !== '') lines.push('')
      lines.push(...block.lines)
    }
    result = lines.join(newline) + (trailing || !text ? newline : '')
  }
  return result
}

/** Removes the lines of `keys`, and the blank line after each when `gap` is set. */
export function removeBlocks(
  text: string,
  keys: readonly string[],
  spansOf: (text: string) => LineSpan[],
  gap: boolean,
): string {
  const wanted = new Set(keys)
  const newline = newlineOf(text)
  const lines = text.split(/\r?\n/)
  const drop = new Set<number>()
  for (const span of spansOf(text)) {
    if (!wanted.has(span.key)) continue
    for (let line = span.start; line <= span.end; line++) drop.add(line - 1)
    if (gap && lines[span.end] === '' && span.end < lines.length - 1) drop.add(span.end)
  }
  return lines.filter((_, index) => !drop.has(index)).join(newline)
}
