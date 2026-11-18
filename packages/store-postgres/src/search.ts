import { searchWords } from '@holtkeeper/store'
import type { SQL } from 'bun'

import type { Tables } from './tables.ts'

/**
 * Distinct lowercase words of a search text. Each becomes a quoted prefix operand of the
 * `tsquery`, so operators, quotes and punctuation in the input never reach the query parser.
 */
export const searchTerms = (text: string): string[] => [...new Set(searchWords(text))]

/** `ts_rank` weights in `{D, C, B, A}` order: A 5, B 3, C 1, as the SQLite bm25 weights. */
export const RANK_WEIGHTS = [0, 0.2, 0.6, 1] as const

/** A `tsquery` OR-ing every term as an accent-folded prefix: `'migr':* | 'react':*`. */
export const prefixTsQuery = (sql: SQL, t: Tables, terms: readonly string[]) => sql`
  (SELECT to_tsquery('simple', string_agg(
    '''' || replace(replace(${t.knowledgeFold}(term), '\\', '\\\\'), '''', '''''') || ''':*',
    ' | '))
  FROM jsonb_array_elements_text(${sql.json([...terms])}::jsonb) AS term)`
