import type { ActivityPerson } from '@holtkeeper/api'

/** Up to two initials of a name, `?` when it has none. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '?'

/** Generated avatar of an id that is not a known user, e.g. a service account. */
export const avatarOf = (seed: string): string => `/api/avatars/${encodeURIComponent(seed)}.svg`

/** How an activity actor or subject is shown: the user's name and avatar, else the raw id. */
export const personOf = (
  people: Readonly<Record<string, ActivityPerson>>,
  id: string,
): ActivityPerson & { known: boolean } => {
  const person = people[id]
  return person ? { ...person, known: true } : { name: id, avatarUrl: avatarOf(id), known: false }
}
