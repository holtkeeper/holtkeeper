import { TEAM_KEY_PATTERN, type TeamConfigView } from '@holtkeeper/api'

/** What people see for a team key: its display title, or the key itself. */
export type TeamTitleOf = (key: string) => string

/** Shows every team by its key; for callers without titles at hand. */
export const keyAsTitle: TeamTitleOf = (key) => key

/** A `TeamTitleOf` over `MeResponse.teamTitles`; unknown and untitled keys stay as they are. */
export const teamTitleOf =
  (titles: Readonly<Record<string, string>> | undefined): TeamTitleOf =>
  (key) =>
    titles && Object.hasOwn(titles, key) ? (titles[key] ?? key) : key

/** Orders team keys by what people see, then by key. */
export const byTeamTitle =
  (titleOf: TeamTitleOf) =>
  (a: string, b: string): number =>
    titleOf(a).localeCompare(titleOf(b)) || a.localeCompare(b)

/** Checks a team key: lowercase letters, digits and dashes, starting with a letter. */
export const validateTeamKey = (key: string): string | undefined =>
  TEAM_KEY_PATTERN.test(key.trim())
    ? undefined
    : 'Lowercase letters, digits and dashes, starting with a letter'

/** Whether a team matches a filter typed by people, by its title or its key. */
export function teamMatchesQuery(key: string, titleOf: TeamTitleOf, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return (
    !needle || key.toLowerCase().includes(needle) || titleOf(key).toLowerCase().includes(needle)
  )
}

/** Longest display title a team takes, as the server checks it. */
const MAX_TEAM_TITLE = 60

/** Checks a display name typed for a team; empty means none. `undefined` when it is valid. */
export const validateTeamTitle = (text: string): string | undefined =>
  text.trim().length > MAX_TEAM_TITLE ? `At most ${MAX_TEAM_TITLE} characters` : undefined

/** `data` with the display name `text`, trimmed; an empty name removes the title. */
export function withTeamTitle(data: TeamConfigView, text: string): TeamConfigView {
  const { title: _title, ...rest } = data
  const title = text.trim()
  return title ? { ...rest, title } : rest
}
