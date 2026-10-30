import type { KnowledgeEntry } from '@holtkeeper/store'
import { knowledgeWords } from '@holtkeeper/store'

const stopWords = new Set(
  'a an and are as at be but by do for from has have i if in into is it its of on or so that the their them then there these this to use used uses using was we were when which will with you your'.split(
    ' ',
  ),
)

/** Lowercase words of `text` without common English stop words. */
export const significantWords = (text: string): string[] =>
  knowledgeWords(text).filter((word) => !stopWords.has(word))

/** Rough token count used for budgets: four characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Jaccard similarity (0–1) of the significant word sets of two texts. */
export function textOverlap(a: string, b: string): number {
  const left = new Set(significantWords(a))
  const right = new Set(significantWords(b))
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/** Hash of the words of `text`, so case, punctuation and spacing do not matter. */
export const contentHash = (text: string): string =>
  new Bun.CryptoHasher('sha256').update(knowledgeWords(text).join(' ')).digest('hex')

const hit = (words: string[], term: string) => words.some((word) => word.startsWith(term))

/**
 * How well `query` describes `entry`: for every query word, a prefix hit in the title counts 3,
 * in topics or package names 2, in the body 1; the sum is divided by the number of query words.
 * 0 when nothing matches or the query is blank.
 */
export function relevance(entry: KnowledgeEntry, query: string): number {
  const terms = [...new Set(significantWords(query))]
  if (!terms.length) return 0
  const title = knowledgeWords(entry.title)
  const tags = knowledgeWords(
    [...entry.topics, ...(entry.packages ?? []).map((pkg) => pkg.name)].join(' '),
  )
  const body = knowledgeWords(entry.body)
  let score = 0
  for (const term of terms) {
    if (hit(title, term)) score += 3
    if (hit(tags, term)) score += 2
    if (hit(body, term)) score += 1
  }
  return score / terms.length
}
