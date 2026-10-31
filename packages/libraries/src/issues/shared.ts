import type { LibraryIssue, LibraryRef, LibraryRepository } from '@holtkeeper/store'

/** An issue as the GitHub fetchers produce it, before the library it belongs to is attached. */
export type FetchedIssue = Omit<LibraryIssue, keyof LibraryRef>

const BODY_CHARS = 2000

const VERSION = String.raw`v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)`
const MILESTONE = new RegExp(`^(?:[\\w@/.-]+@)?${VERSION}$`)
const FIXED_IN = new RegExp(
  String.raw`\b(?:fixed|released|landed|shipped|published|available|resolved)\s+(?:in|with|as of|since)\s+(?:version\s+|release\s+)?` +
    '`?' +
    String.raw`(?:[\w@/.-]+@)?` +
    VERSION,
  'i',
)

/** `<host>/<owner>/<repo>#<number>`. */
export const issueId = (repo: LibraryRepository, number: number) =>
  `${repo.host}/${repo.path}#${number}`

export const trimText = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

/** Drops HTML comments, unticked or ticked checklist lines and blank runs that issue templates leave. */
export function cleanBody(body: string | null | undefined, max = BODY_CHARS): string {
  if (!body) return ''
  const cleaned = body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*[-*]\s+\[[ xX]\]\s/.test(line))
    .join('\n')
    .replace(/^#{1,6} .+\n+(?=#{1,6} |(?![\s\S]))/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return trimText(cleaned, max)
}

/** A milestone title that names a release, as a bare version. */
export function versionOfMilestone(title: string | null | undefined): string | undefined {
  return title ? MILESTONE.exec(title.trim())?.[1] : undefined
}

/** A version named by "fixed in vX", "released in X" and similar phrases. */
export function fixedInText(text: string | null | undefined): string | undefined {
  return text ? FIXED_IN.exec(text)?.[1] : undefined
}

const BUGGY = /bug|regression|breaking/i

/** Labels like `bug`, `type: bug`, `Regression`, `breaking change`. */
export const hasBugLabel = (labels: readonly string[]) => labels.some((label) => BUGGY.test(label))

export interface RestIssue {
  number: number
  title: string
  html_url: string
  state: string
  state_reason?: string | null
  labels?: (string | { name?: string })[]
  body?: string | null
  comments?: number
  reactions?: { total_count?: number }
  milestone?: { title?: string } | null
  pull_request?: unknown
  created_at: string
  updated_at: string
  closed_at?: string | null
}

const restLabels = (labels: RestIssue['labels']) =>
  (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter(Boolean)

/** A REST issue (listing or search item) as a stored issue without answer or pull requests. */
export function fromRest(repo: LibraryRepository, item: RestIssue): FetchedIssue {
  const fixedIn = versionOfMilestone(item.milestone?.title)
  return {
    id: issueId(repo, item.number),
    number: item.number,
    kind: 'issue',
    title: item.title,
    state: item.state === 'closed' ? 'closed' : 'open',
    labels: restLabels(item.labels),
    url: item.html_url,
    body: cleanBody(item.body),
    pulls: [],
    ...(fixedIn ? { fixedIn } : {}),
    reactions: item.reactions?.total_count ?? 0,
    comments: item.comments ?? 0,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    ...(item.closed_at ? { closedAt: item.closed_at } : {}),
  }
}
