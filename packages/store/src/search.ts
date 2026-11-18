/** Lowercase words of `text`: letters, digits and underscores; everything else separates. */
export const searchWords = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

/**
 * A relevance score of `terms` (lowercase prefixes) over weighted fields: every field adds
 * `weight · hits / (hits + 1)` per term, so more matching words and heavier fields rank higher.
 */
export function prefixScore(
  terms: readonly string[],
  fields: readonly (readonly [weight: number, text: string])[],
): number {
  const words = fields.map(([weight, text]) => [weight, searchWords(text)] as const)
  let score = 0
  for (const term of terms)
    for (const [weight, list] of words) {
      const hits = list.filter((word) => word.startsWith(term)).length
      if (hits) score += (weight * hits) / (hits + 1)
    }
  return score
}
