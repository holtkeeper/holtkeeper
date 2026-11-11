const languageOrder = ['JavaScript', 'Go', 'Python', 'Java', 'Rust', 'PHP', 'Ruby', 'C#']

/** Stable categorical color of a language, so it keeps its color across pages and filters. */
export const languageColor = (language: string): string => {
  const slot = languageOrder.indexOf(language)
  return slot < 0 ? 'var(--sev-unknown)' : `var(--series-${slot + 1})`
}

/** Semantic color of a status: one accent, the rest only for state. */
export type StatusTone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'code'

/** CSS color of a status tone, for fills, strokes and inline styles. */
export const statusColor: Record<StatusTone, string> = {
  default: 'var(--fg-muted)',
  accent: 'var(--brand)',
  success: 'var(--ok)',
  warning: 'var(--warn)',
  danger: 'var(--bad)',
  info: 'var(--info)',
  code: 'var(--code)',
}
