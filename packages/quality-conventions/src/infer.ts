import { CASE_STYLES, type CaseStyle, classifyCase, compatibleStyles } from './case.ts'

const singleWord = (style: CaseStyle) => style === 'flatcase' || style === 'UPPERCASE'

/** When a kind of name counts as having a convention. */
export interface ConventionThresholds {
  /** Fewest classifiable names a kind needs. Default 10. */
  minNames?: number
  /** Smallest share of names in the dominant style, 0..1. Default 0.8. */
  minShare?: number
}

/** The style a set of names is written in and how consistently. */
export interface InferredConvention {
  dominant: CaseStyle
  /** Names that fit the dominant style, single words included, over `total`. */
  share: number
  /** Names that can be classified; `_` and similar are left out. */
  total: number
  /** Indexes into the input of names that do not fit the dominant style. */
  outliers: number[]
  /**
   * Whether the thresholds are met, so outliers are worth reporting. Names of more than one word
   * must meet `minShare` on their own too: single words fit many styles and prove none.
   */
  established: boolean
}

/**
 * Infers the dominant style of `names`. The dominant style is the one most names fit; single
 * words fit several styles and break ties only after names that are evidence for one style.
 * Returns `undefined` when no name can be classified.
 */
export function inferConvention(
  names: readonly string[],
  { minNames = 10, minShare = 0.8 }: ConventionThresholds = {},
): InferredConvention | undefined {
  const fitting = new Map<CaseStyle, number>()
  const exact = new Map<CaseStyle, number>()
  let total = 0
  for (const name of names) {
    const style = classifyCase(name)
    if (style === undefined) continue
    total++
    exact.set(style, (exact.get(style) ?? 0) + 1)
    for (const compatible of compatibleStyles(name))
      fitting.set(compatible, (fitting.get(compatible) ?? 0) + 1)
  }
  if (!total) return undefined

  const evidence = (style: CaseStyle) => (exact.get(style) ?? 0) * (singleWord(style) ? 0.5 : 1)
  const multiWord = names.filter((name) => {
    const style = classifyCase(name)
    return style !== undefined && !singleWord(style)
  })
  // Single words say nothing about how longer names are joined, so they never become the style.
  const candidates = multiWord.length
    ? CASE_STYLES.filter((style) => !singleWord(style))
    : CASE_STYLES
  const dominant =
    candidates
      .toSorted(
        (a, b) => (fitting.get(b) ?? 0) - (fitting.get(a) ?? 0) || evidence(b) - evidence(a),
      )
      .find((style) => fitting.has(style)) ?? 'mixed'
  const share = (fitting.get(dominant) ?? 0) / total
  const outliers = names.flatMap((name, index) =>
    classifyCase(name) !== undefined && !compatibleStyles(name).includes(dominant) ? [index] : [],
  )
  const multiWordShare =
    multiWord.filter((name) => compatibleStyles(name).includes(dominant)).length /
    (multiWord.length || 1)
  return {
    dominant,
    share,
    total,
    outliers,
    established:
      total >= minNames && share >= minShare && multiWord.length > 0 && multiWordShare >= minShare,
  }
}
