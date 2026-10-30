import { localeTag, locateCatalog } from '../locate.ts'
import type { CatalogEntry, CatalogSource } from '../types.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Leaf entries of a YAML catalog; a single top-level locale key (Rails style) is unwrapped. */
export function yamlEntries(text: string): CatalogEntry[] {
  const parsed: unknown = Bun.YAML.parse(text)
  if (parsed === null || parsed === undefined) return []
  if (!isRecord(parsed)) throw new SyntaxError('a catalog must be a YAML mapping')
  const top = Object.keys(parsed)
  const root = top.length === 1 && localeTag(top[0]!) ? parsed[top[0]!] : undefined
  const data = isRecord(root) ? root : parsed
  const lines = text.split(/\r?\n/)
  const lineOf = (segment: string, from: number) => {
    const pattern = new RegExp(
      `^\\s*["']?${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`,
    )
    for (let i = from; i < lines.length; i++) if (pattern.test(lines[i]!)) return i + 1
    return from + 1
  }
  const entries: CatalogEntry[] = []
  const walk = (node: Record<string, unknown>, prefix: string, from: number) => {
    let cursor = from
    for (const [name, value] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${name}` : name
      const line = lineOf(name, cursor)
      cursor = line - 1
      if (typeof value === 'string') entries.push({ key, value, line })
      else if (typeof value === 'number' || typeof value === 'boolean')
        entries.push({ key, value: String(value), line })
      else if (isRecord(value)) walk(value, key, line)
    }
  }
  walk(data, '', 0)
  return entries
}

/** YAML catalogs (`locales/ru.yml`, Rails `config/locales/*.yml`); read-only, no edits. */
export const yamlSource = (): CatalogSource => ({
  format: 'yaml',
  matches: (file) => /\.ya?ml$/i.test(file),
  locate: locateCatalog,
  parse: (text) => ({ entries: yamlEntries(text) }),
})
