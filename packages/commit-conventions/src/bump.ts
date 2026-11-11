/** How far a commit moves a semantic version. */
export type CommitBump = 'major' | 'minor' | 'patch'

const leadingTickets = /^(?:\[[A-Z][A-Z0-9]{1,9}-\d+\]\s*|[A-Z][A-Z0-9]{1,9}-\d+(?::\s*|\s+))+/u
const conventional = /^(?<type>[a-z][\w-]*)(?:\([^)]*\))?(?<bang>!)?\s?:\s?\S/iu
const breakingFooter = /^BREAKING[ -]CHANGES?:/mu
const minorTypes = new Set(['feat', 'feature', 'features'])

/**
 * The bump one commit calls for under Conventional Commits: a breaking change (`type!:` or a
 * `BREAKING CHANGE:` footer) is `major`, `feat` (and its spellings `feature`, `features`) is
 * `minor`, anything else, conventional or not, is `patch`. Leading ticket keys (`[ABC-1] feat:`,
 * `ABC-1: feat:`, `ABC-1 feat:`) are skipped before the type is read.
 */
export function bumpFor(commit: { title: string; body?: string }): CommitBump {
  if (commit.body && breakingFooter.test(commit.body)) return 'major'
  const match = conventional.exec(commit.title.trim().replace(leadingTickets, ''))?.groups
  if (!match?.type) return 'patch'
  if (match.bang) return 'major'
  return minorTypes.has(match.type.toLowerCase()) ? 'minor' : 'patch'
}
