import { z } from 'zod'

import { parseHtmlTables, parseMarkdownTables, type Table } from '../html.ts'
import type { Extracted } from '../types.ts'
import { type DocumentExtractor, headingMatches } from './types.ts'

const schema = z.object({
  kind: z.literal('table'),
  /** Only tables under a heading containing this text (case-insensitive). */
  heading: z.string().min(1).optional(),
  /** Header of the column holding the key, matched case-insensitively. */
  keyColumn: z.string().min(1),
  /** Attribute name → column header. Default: every other column, named by its lowercased header. */
  columns: z.record(z.string().min(1), z.string().min(1)).optional(),
})

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Tables of a document body in its own format. */
export function documentTables(format: string, body: string): Table[] {
  return format === 'markdown' ? parseMarkdownTables(body) : parseHtmlTables(body)
}

/** Rows of the tables that have `keyColumn`, one entity per row with a non-empty key. */
export const tableExtractor = {
  kind: 'table',
  schema,
  extract(document, config) {
    const results: Extracted[] = []
    for (const table of documentTables(document.format, document.body)) {
      if (!headingMatches(table.heading, config.heading)) continue
      const keyIndex = table.headers.findIndex((header) => same(header, config.keyColumn))
      if (keyIndex < 0) continue
      const columns = config.columns
        ? Object.entries(config.columns).map(
            ([attr, header]) =>
              [attr, table.headers.findIndex((name) => same(name, header))] as const,
          )
        : table.headers.flatMap((header, index) =>
            index === keyIndex || !header ? [] : [[header.trim().toLowerCase(), index] as const],
          )
      for (const row of table.rows) {
        const key = row[keyIndex]?.trim()
        if (!key) continue
        const attrs: Record<string, string> = {}
        for (const [attr, index] of columns) {
          const value = index >= 0 ? row[index]?.trim() : undefined
          if (value) attrs[attr] = value
        }
        results.push({ key, attrs })
      }
    }
    return results
  },
} satisfies DocumentExtractor<z.output<typeof schema>>
