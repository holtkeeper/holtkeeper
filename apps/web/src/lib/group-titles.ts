import {
  GROUP_KEY_PATTERN,
  type GroupDocumentData,
  type GroupMatch,
  parentGroup,
  rootGroup,
} from '@holtkeeper/api'

/** What people see for a group key: its display title, or the key itself. */
export type GroupTitleOf = (key: string) => string

/** Shows every group by its key; for callers without titles at hand. */
export const keyAsTitle: GroupTitleOf = (key) => key

/** A `GroupTitleOf` over `MeResponse.groupTitles`; unknown and untitled keys stay as they are. */
export const groupTitleOf =
  (titles: Readonly<Record<string, string>> | undefined): GroupTitleOf =>
  (key) =>
    titles && Object.hasOwn(titles, key) ? (titles[key] ?? key) : key

/** A group list entry for reading: `Frontend`, or `Frontend + Storefront` for an intersection. */
export const groupMatchTitle = (entry: GroupMatch, titleOf: GroupTitleOf): string =>
  typeof entry === 'string' ? titleOf(entry) : entry.map(titleOf).join(' + ')

/** Orders group keys by what people see, then by key. */
export const byGroupTitle =
  (titleOf: GroupTitleOf) =>
  (a: string, b: string): number =>
    titleOf(a).localeCompare(titleOf(b)) || a.localeCompare(b)

/** A group with its parent in front for a subgroup: `Shape studio › Round`; a root group's title. */
export function groupPathTitle(titleOf: GroupTitleOf, key: string): string {
  const parent = parentGroup(key)
  return parent === undefined
    ? titleOf(key)
    : `${groupPathTitle(titleOf, parent)} › ${titleOf(key)}`
}

/**
 * Orders group keys as a tree: root groups by title, each followed by its subgroups by title. A
 * subgroup whose parent is not in the list still sorts where its parent would.
 */
export const byGroupTree = (titleOf: GroupTitleOf) => {
  const byTitle = byGroupTitle(titleOf)
  return (a: string, b: string): number => {
    const roots = byTitle(rootGroup(a), rootGroup(b))
    if (roots) return roots
    const aSub = parentGroup(a) !== undefined
    const bSub = parentGroup(b) !== undefined
    return aSub === bSub ? byTitle(a, b) : aSub ? 1 : -1
  }
}

/** Checks a group key: `team` or a subgroup `team.sub`, lowercase letters, digits and dashes. */
export const validateGroupKey = (key: string): string | undefined =>
  GROUP_KEY_PATTERN.test(key.trim())
    ? undefined
    : 'Lowercase letters, digits and dashes, with one optional dot for a subgroup (team.sub)'

/** Whether a group matches a filter typed by people, by its title or its key. */
export function groupMatchesQuery(key: string, titleOf: GroupTitleOf, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return (
    !needle || key.toLowerCase().includes(needle) || titleOf(key).toLowerCase().includes(needle)
  )
}

/** Longest display title a group takes, as the server checks it. */
export const MAX_GROUP_TITLE = 60

/** Checks a display name typed for a group; empty means none. `undefined` when it is valid. */
export const validateGroupTitle = (text: string): string | undefined =>
  text.trim().length > MAX_GROUP_TITLE ? `At most ${MAX_GROUP_TITLE} characters` : undefined

/** `data` with the display name `text`, trimmed; an empty name removes the title. */
export function withGroupTitle(data: GroupDocumentData, text: string): GroupDocumentData {
  const { title: _title, ...rest } = data
  const title = text.trim()
  return title ? { ...rest, title } : rest
}
