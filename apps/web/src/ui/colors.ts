const languageOrder = ['JavaScript', 'Go', 'Python', 'Java', 'Rust', 'PHP', 'Ruby', 'C#']

/** Stable categorical color of a language, so it keeps its color across pages and filters. */
export const languageColor = (language: string): string => {
  const slot = languageOrder.indexOf(language)
  return slot < 0 ? 'var(--sev-unknown)' : `var(--series-${slot + 1})`
}
