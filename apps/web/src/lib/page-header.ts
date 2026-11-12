/**
 * The tab whose `to` the pathname is at or under; the longest match wins, so `/repos/groups`
 * beats `/repos`. `/` only matches itself. `undefined` when no tab matches.
 */
export function currentTab<T extends { to: string }>(
  tabs: readonly T[],
  pathname: string,
): T | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  let best: T | undefined
  for (const tab of tabs) {
    const to = tab.to.length > 1 ? tab.to.replace(/\/+$/, '') : tab.to
    const matches = to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)
    if (matches && (!best || to.length > best.to.length)) best = tab
  }
  return best
}

/** The accessible name of an overflow menu, listing what it holds: "More actions: export, delete". */
export const moreMenuLabel = (labels: readonly string[]): string =>
  labels.length
    ? `More actions: ${labels.map((label) => label.toLowerCase()).join(', ')}`
    : 'More actions'
