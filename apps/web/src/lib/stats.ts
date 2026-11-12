/** Median of `values`; `undefined` when there are none. */
export const median = (values: readonly number[]): number | undefined => {
  if (!values.length) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** `values` without the `undefined` ones, in order. */
export const defined = (values: readonly (number | undefined)[]): number[] =>
  values.filter((value): value is number => value !== undefined)
