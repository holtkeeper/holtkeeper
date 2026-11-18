/** Values a rules file's frontmatter may hold: strings, booleans and lists of strings. */
export type FrontmatterValue = string | boolean | string[]

/** A rules file split into its frontmatter and Markdown body. */
export interface Frontmatter {
  data: Record<string, FrontmatterValue>
  body: string
}

const unquote = (value: string): string => {
  const trimmed = value.trim()
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  return quoted ? (quoted[2] ?? '') : trimmed
}

const scalar = (raw: string): FrontmatterValue => {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  const inline = /^\[(.*)\]$/.exec(value)
  if (inline) {
    return (inline[1] ?? '')
      .split(',')
      .map(unquote)
      .filter((item) => item.length > 0)
  }
  return unquote(value)
}

/**
 * Splits `text` at a leading `---` frontmatter block. Reads the flat subset rules files use
 * (`key: value`, `key: [a, b]`, `key:` followed by `- item` lines, `true`/`false`); anything else
 * in the block is ignored. Text without frontmatter returns it whole as the body.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { data: {}, body: text.trim() }
  const data: Record<string, FrontmatterValue> = {}
  let listKey: string | undefined
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line)
    if (item && listKey) {
      const list = data[listKey]
      const value = unquote(item[1] ?? '')
      data[listKey] = Array.isArray(list) ? [...list, value] : [value]
      continue
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!pair?.[1]) continue
    const raw = pair[2] ?? ''
    listKey = raw.trim() === '' ? pair[1] : undefined
    if (raw.trim() !== '') data[pair[1]] = scalar(raw)
  }
  return { data, body: text.slice(match[0].length).trim() }
}

/** A frontmatter value as a list of globs: lists as they are, strings split at commas. */
export function globList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined || typeof value === 'boolean') return []
  const items = Array.isArray(value) ? value : value.split(',')
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}
