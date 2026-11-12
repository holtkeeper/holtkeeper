import type { GroupDocumentData, GroupMatch } from '@holtkeeper/api'

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
