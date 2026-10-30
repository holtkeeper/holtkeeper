import type { ParsedCommit, Person } from './types.ts'

const typeAliases: Record<string, string> = {
  feature: 'feat',
  features: 'feat',
  bugfix: 'fix',
  hotfix: 'fix',
  doc: 'docs',
  tests: 'test',
  performance: 'perf',
  chores: 'chore',
}

const conventional = /^(?<type>[a-z][\w-]*)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<rest>.*)$/iu
const ticketKey = /(?<![\w-])([A-Z][A-Z0-9]{1,9})-(\d+)(?![\w-])/gu
const notTickets = new Set(['UTF', 'ISO', 'RFC', 'SHA', 'CVE', 'ECMA', 'ES', 'TLS', 'SSL', 'MD'])
const issueRef = /(?<![\w&/!])#(\d+)\b/gu
const prSuffix = /\s*\(#(\d+)\)\s*$/u
const gitlabMrRef = /(?<![\w!])!(\d+)\b/gu
const seeMergeRequest = /^See merge request\s+(?:\S+?)?!(\d+)\s*$/imu
const githubMerge = /^Merge pull request #(\d+)\b/u
const mergeSubject = /^Merge (?:branch|pull request|remote-tracking branch|tag|commit|changes)\b/u
const revertSubject = /^Revert\s+"(.+)"\s*$/u
const revertsSha = /This reverts commit ([0-9a-f]{7,40})/u
const breakingFooter = /^BREAKING[ -]CHANGES?:\s*([\s\S]*?)(?:\n\s*\n|$)/mu
const coAuthor = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gimu
const wipMarker = /^(?:(?:fixup|squash|amend)!\s*)+|^\[?wip\]?(?::|\s|$)/iu

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** Tracker keys and `#n` issue references in `text`, in order of appearance. */
export function findTickets(text: string): string[] {
  const found: { at: number; id: string }[] = []
  for (const match of text.matchAll(ticketKey)) {
    if (!notTickets.has(match[1] ?? '')) found.push({ at: match.index, id: match[0] })
  }
  for (const match of text.matchAll(issueRef)) found.push({ at: match.index, id: match[0] })
  return unique(found.toSorted((a, b) => a.at - b.at).map((item) => item.id))
}

function cleanDescription(text: string): string {
  return text
    .replace(prSuffix, '')
    .replace(/^(?:\[[A-Z][A-Z0-9]+-\d+\]\s*)+/u, '')
    .replace(/^(?:[A-Z][A-Z0-9]+-\d+[:\s]\s*)+/u, '')
    .trim()
}

function mergeTitle(body: string): string | undefined {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find(
      (line) => line && !seeMergeRequest.test(line) && !/^(?:Closes|Fixes|Resolves)\b/iu.test(line),
    )
}

/**
 * Interprets a commit message: Conventional Commits type, scope and breaking marker, ticket and
 * merge request references, merges, reverts and co-authors. Never throws; anything unrecognized
 * leaves `type` undefined and the subject as the description.
 */
export function parseCommit(subject: string, body = ''): ParsedCommit {
  subject = subject.trim()
  body = body.trim()
  const mergeRequests: number[] = []
  const tickets = new Set<string>()

  const merge = mergeSubject.test(subject)
  const github = githubMerge.exec(subject)
  if (github) mergeRequests.push(Number(github[1]))
  const see = seeMergeRequest.exec(body)
  if (see) mergeRequests.push(Number(see[1]))
  const suffix = prSuffix.exec(subject)
  if (suffix) mergeRequests.push(Number(suffix[1]))
  for (const match of subject.matchAll(gitlabMrRef)) mergeRequests.push(Number(match[1]))

  let headline = subject
  if (merge) headline = mergeTitle(body) ?? subject
  const wip = wipMarker.test(headline)
  headline = headline.replace(wipMarker, '').trim()

  const revertMatch = revertSubject.exec(headline)
  const revertedSha = revertsSha.exec(body)?.[1]

  const prRefs = new Set(mergeRequests.map((n) => `#${n}`))
  for (const id of findTickets(`${subject}\n${body}`)) {
    if (!prRefs.has(id)) tickets.add(id)
  }

  const parsed: ParsedCommit = {
    breaking: false,
    description: cleanDescription(headline),
    tickets: [...tickets],
    mergeRequests: unique(mergeRequests),
    merge,
    coAuthors: [...body.matchAll(coAuthor)].map((match): Person => ({
      name: match[1] ?? '',
      email: match[2] ?? '',
    })),
    wip,
  }

  const conv = revertMatch ? undefined : conventional.exec(headline)?.groups
  if (conv?.type && conv.rest !== undefined) {
    const raw = conv.type.toLowerCase()
    parsed.type = typeAliases[raw] ?? raw
    if (conv.scope?.trim()) parsed.scope = conv.scope.trim()
    parsed.breaking = Boolean(conv.bang)
    parsed.description = cleanDescription(conv.rest) || conv.rest.trim()
  }

  const footer = breakingFooter.exec(body)
  if (footer) {
    parsed.breaking = true
    const note = footer[1]?.trim()
    if (note) parsed.breakingNote = note
  }

  if (revertMatch || parsed.type === 'revert') {
    parsed.type = 'revert'
    parsed.revert = {
      ...(revertMatch?.[1] ? { subject: revertMatch[1] } : {}),
      ...(revertedSha ? { sha: revertedSha } : {}),
    }
    if (revertMatch?.[1]) parsed.description = cleanDescription(revertMatch[1])
  }

  return parsed
}
