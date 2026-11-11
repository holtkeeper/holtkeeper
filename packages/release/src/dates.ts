/** Calendar parts of a moment in UTC, zero-padded. */
export function dateParts(at: Date) {
  const iso = at.toISOString()
  return { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10) }
}

/** `at` as `YYYY-MM-DD` in UTC. */
export const isoDate = (at: Date) => at.toISOString().slice(0, 10)
