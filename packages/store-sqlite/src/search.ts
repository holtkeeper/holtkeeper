import { searchWords } from '@holtkeeper/store'

/**
 * Turns free text into an FTS5 query that cannot fail to parse: every word becomes a quoted
 * prefix term (`"migr"*`) and terms are OR-ed, so bm25 ranks rows matching more words higher.
 * Operators (`AND`, `NEAR`, `-`, `:`) and quotes in the input end up as plain words or are dropped.
 */
export function ftsQuery(text: string): string | undefined {
  const terms = [...new Set(searchWords(text))]
  if (!terms.length) return undefined
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ')
}
