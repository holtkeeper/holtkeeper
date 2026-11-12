const count = new Intl.NumberFormat('en')

/** `Showing 10 of 1,284`, or `Showing all 12` once every item is on screen. */
export function shownText(shown: number, total: number, noun?: string): string {
  const tail = noun ? ` ${noun}` : ''
  if (shown >= total) return `Showing ${total > 1 ? 'all ' : ''}${count.format(total)}${tail}`
  return `Showing ${count.format(shown)} of ${count.format(total)}${tail}`
}
