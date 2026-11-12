/**
 * Text of a filter button: `Label: All` with nothing chosen, `Label: A, B` for up to `shown`
 * values, then `Label: A, B +3`.
 */
export function filterLabel(
  label: string,
  values: readonly string[],
  { all = 'All', shown = 2 }: { all?: string; shown?: number } = {},
): string {
  if (!values.length) return `${label}: ${all}`
  const head = values.slice(0, Math.max(1, shown)).join(', ')
  const rest = values.length - Math.max(1, shown)
  return rest > 0 ? `${label}: ${head} +${rest}` : `${label}: ${head}`
}
