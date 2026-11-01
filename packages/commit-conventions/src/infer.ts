import { hasBody, parseTitle, ticketKeys, ticketPattern, ticketPlacement } from './title.ts'
import type { BranchRules, CommitRules, Count, TicketPlacement, TicketRule } from './types.ts'

/** A commit as inference reads it. */
export interface HistoryCommit {
  title: string
  message: string
  parents?: readonly string[]
}

/** A branch as inference reads it. */
export interface HistoryBranch {
  name: string
  committedAt?: string
  default?: boolean
  protected?: boolean
}

/** Thresholds of inference; the defaults suit most repositories. */
export interface InferOptions {
  /** Fewer analyzed commits than this establish no commit rule. Default 10. */
  minCommits?: number
  /** Fewer analyzed branches than this establish no branch rule. Default 5. */
  minBranches?: number
  /** Share of names a style needs to become a rule. Default 0.8. */
  minShare?: number
}

/** Commit rules the history establishes, with counts for the reader. */
export interface InferredCommits {
  rules: CommitRules
  analyzed: number
  conventionalShare: number
  ticketShare: number
  types: Count[]
  scopes: Count[]
}

/** Branch rules the existing branches establish. */
export interface InferredBranches {
  rules: BranchRules
  analyzed: number
}

const skipped = /^(?:Merge |Revert "|(?:fixup|squash|amend)!|\[?wip\]?(?::|\s|$))/iu

function counts(values: Iterable<string>): Count[] {
  const map = new Map<string, number>()
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1)
  return [...map]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole)

/** The most common value when it covers at least `min` of `values`. */
function dominant<T extends string>(values: readonly T[], min: number): T | undefined {
  const top = counts(values)[0]
  if (!top || share(top.count, values.length) < min) return undefined
  return values.find((value) => value === top.name)
}

function ticketRule(keys: string[][], total: number, minShare: number): TicketRule | undefined {
  const withKey = keys.filter((list) => list.length > 0)
  if (share(withKey.length, total) < 0.3) return undefined
  const projects = counts(withKey.flat().map((key) => key.slice(0, key.indexOf('-'))))
  const common = projects.filter((project) => project.count >= 2)
  return {
    pattern: ticketPattern((common.length ? common : projects).map((project) => project.name)),
    required: share(withKey.length, total) >= minShare,
  }
}

/** The shape of a title that follows `rules`, with `<type>`, `<scope>`, `<TICKET>` and `<subject>`. */
export function commitTemplate(rules: CommitRules): string {
  const ticket = rules.ticket ? '<TICKET>' : ''
  const placement = rules.ticket?.placement
  const scope = placement === 'scope' ? `(${ticket})` : rules.scopeRequired ? '(<scope>)' : ''
  const lead = placement === 'lead' ? `[${ticket}] ` : ''
  const head = rules.conventional ? `<type>${scope}: ` : ''
  const subject =
    placement === 'bracket'
      ? `[${ticket}] <subject>`
      : placement === 'prefix'
        ? `${ticket} <subject>`
        : placement === 'suffix'
          ? `<subject> (${ticket})`
          : '<subject>'
  return lead + head + subject
}

/**
 * Commit rules the analyzed commits agree on: a style becomes a rule when at least `minShare` of
 * them follow it. Merges, reverts, `fixup!` and WIP commits are left out. Types and scopes are
 * reported as counts, not rules, because a short history does not show every allowed one.
 */
export function inferCommitRules(
  commits: readonly HistoryCommit[],
  options: InferOptions = {},
): InferredCommits {
  const minShare = options.minShare ?? 0.8
  const analyzed = commits.filter(
    (commit) => (commit.parents?.length ?? 1) < 2 && !skipped.test(commit.title.trim()),
  )
  const titles = analyzed.map((commit) => ({ commit, title: parseTitle(commit.title) }))
  const conventional = titles.filter(({ title }) => title.type)
  const keys = titles.map(({ commit }) => ticketKeys(commit.title))
  const stats = {
    analyzed: analyzed.length,
    conventionalShare: share(conventional.length, analyzed.length),
    ticketShare: share(keys.filter((list) => list.length).length, analyzed.length),
    types: counts(conventional.map(({ title }) => title.type ?? '')),
    scopes: counts(conventional.flatMap(({ title }) => (title.scope ? [title.scope] : []))),
  }
  if (analyzed.length < (options.minCommits ?? 10)) return { rules: {}, ...stats }

  const rules: CommitRules = {}
  if (stats.conventionalShare >= minShare) {
    rules.conventional = true
    if (
      share(conventional.filter(({ title }) => title.scope).length, conventional.length) >= minShare
    )
      rules.scopeRequired = true
  }

  const ticket = ticketRule(keys, analyzed.length, minShare)
  if (ticket) {
    const placements = titles.flatMap(({ title }, index) => {
      const key = keys[index]?.[0]
      return key ? [ticketPlacement(title, key)] : []
    })
    const placement = dominant<TicketPlacement>(placements, 0.6)
    rules.ticket = { ...ticket, placement: placement ?? 'anywhere' }
    if (placement === 'scope') delete rules.scopeRequired
  }

  const lengths = analyzed.map((commit) => commit.title.trim().length)
  for (const limit of [72, 100])
    if (share(lengths.filter((length) => length <= limit).length, lengths.length) >= 0.95) {
      rules.maxLength = limit
      break
    }

  const subjects = titles.map(({ title }) => title.subject.replace(/^\[[^\]]*\]\s*/u, ''))
  const firstLetters = subjects.flatMap((subject) => {
    const first = subject.match(/^(?:[A-Z][A-Z0-9-]+\b|\p{L})/u)?.[0]
    if (!first || first.length > 1) return []
    return [first === first.toLowerCase() ? 'lower' : 'upper'] as const
  })
  const subjectCase = dominant(firstLetters, minShare)
  if (subjectCase && firstLetters.length >= analyzed.length / 2) rules.subjectCase = subjectCase

  if (share(subjects.filter((subject) => subject.endsWith('.')).length, subjects.length) <= 0.05)
    rules.noTrailingPeriod = true

  const bodies = share(analyzed.filter((commit) => hasBody(commit.message)).length, analyzed.length)
  if (bodies <= 1 - minShare) rules.body = 'none'
  else if (bodies >= minShare) rules.body = 'required'

  if (rules.conventional || rules.ticket) rules.template = commitTemplate(rules)
  return { rules, ...stats }
}

const prefixed = /^(?<prefix>[a-z][a-z0-9-]*)\/(?<rest>.+)$/u

/**
 * Branch rules the work branches agree on (the default and protected branches are left out):
 * a prefix such as `feat/`, a ticket key and the case of the rest.
 */
export function inferBranchRules(
  branches: readonly HistoryBranch[],
  options: InferOptions = {},
): InferredBranches {
  const minShare = options.minShare ?? 0.8
  const names = branches
    .filter((branch) => !branch.default && !branch.protected)
    .map((branch) => branch.name)
  if (names.length < (options.minBranches ?? 5)) return { rules: {}, analyzed: names.length }

  const rules: BranchRules = {}
  const split = names.map((name) => prefixed.exec(name)?.groups)
  const prefixes = counts(split.flatMap((groups) => (groups?.prefix ? [groups.prefix] : [])))
  if (
    share(
      prefixes.reduce((sum, p) => sum + p.count, 0),
      names.length,
    ) >= minShare
  ) {
    const common = prefixes.filter((prefix) => prefix.count >= 2)
    rules.prefixes = (common.length ? common : prefixes).map((prefix) => prefix.name)
  }

  const keys = names.map((name) => ticketKeys(name))
  const ticket = ticketRule(keys, names.length, minShare)
  if (ticket) rules.ticket = ticket

  const rests = names.map((name, index) => {
    const rest = split[index]?.rest ?? name
    return keys[index]?.reduce((text, key) => text.replace(key, ''), rest) ?? rest
  })
  const styles = rests.map((rest) =>
    /^[a-z0-9-]*$/u.test(rest) ? 'kebab' : /^[a-z0-9_]*$/u.test(rest) ? 'snake' : 'other',
  )
  const style = dominant(styles, minShare)
  if (style === 'kebab' || style === 'snake') rules.case = style

  const separator = rules.case === 'snake' ? '_' : '-'
  const ticketFirst = rests.filter(
    (rest, index) => keys[index]?.length && /^(?:[-_]|$)/u.test(rest),
  )
  const parts = rules.ticket
    ? share(ticketFirst.length, keys.filter((list) => list.length).length) >= 0.5
      ? `<TICKET>${separator}<description>`
      : `<description>${separator}<TICKET>`
    : '<description>'
  rules.template = `${rules.prefixes ? '<prefix>/' : ''}${parts}`
  return { rules, analyzed: names.length }
}
