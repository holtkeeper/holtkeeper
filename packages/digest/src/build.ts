import type { Card, CardBlock, CardTone } from '@holtkeeper/chat'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind, Block, Issue, Report } from '@holtkeeper/report'
import type { AnalysisRecord } from '@holtkeeper/store'

import type { Digest, DigestSection } from './model.ts'

/** One thing a digest reports. `key` is stable across runs, so later digests can leave it out. */
export interface DigestItem {
  key: string
  repo: RepoRef
  title: string
  detail?: string
  url?: string
  tone: 'info' | 'warning' | 'bad'
}

/** One section of a built digest. */
export interface DigestSectionResult {
  source: string
  label: string
  /** The items shown, most serious first, at most the section's `limit`. */
  items: DigestItem[]
  /** Every item that qualified, before the limit. */
  total: number
  /** Repositories with a report of this kind in the scope. */
  repos: number
}

/** A digest built from the latest analyses, ready to render or send. */
export interface DigestResult {
  digestId: string
  builtAt: string
  sections: DigestSectionResult[]
  /** No section has items. */
  empty: boolean
  /** Keys of every qualifying item, for `onlyNew` of the next run. */
  keys: string[]
}

export interface BuildDigestInput {
  digest: Pick<Digest, 'id' | 'sections' | 'onlyNew'>
  /** The latest record of each (repository, kind); records of other kinds are ignored. */
  records: readonly AnalysisRecord[]
  /** Analysis kinds by kind, to build their reports. */
  kinds: ReadonlyMap<string, AnalysisKind>
  /** Whether a repository is in the digest's scope. */
  covers(repo: RepoRef): boolean
  /** Keys the previous digest listed; left out with `onlyNew`. */
  previousKeys?: ReadonlySet<string>
  /** Turns report links (often panel-relative) into absolute URLs; default keeps them. */
  resolveUrl?(href: string): string | undefined
  now: Date
}

const rank = { info: 1, warning: 2, bad: 3 } as const

const repoKeyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const isBlocks = (value: unknown): value is Block[] => Array.isArray(value)

/** Every issue of a report, from its sections and from blocks nested in them. */
export function reportIssues(report: Report): Issue[] {
  const found: Issue[] = []
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.type === 'issues') found.push(...block.items)
      const nested: unknown = Reflect.get(block, 'blocks')
      if (isBlocks(nested)) walk(nested)
    }
  }
  for (const section of report.sections) walk(section.blocks)
  return found
}

const sectionItems = (
  section: DigestSection,
  input: BuildDigestInput,
): { label: string; items: DigestItem[]; repos: number } => {
  const kind = input.kinds.get(section.source)
  if (!kind) return { label: section.source, items: [], repos: 0 }
  const records = input.records.filter(
    (record) => record.kind === section.source && input.covers(record.repo),
  )
  const items: DigestItem[] = []
  for (const record of records) {
    let report: Report
    try {
      report = kind.toReport(record)
    } catch {
      continue
    }
    for (const issue of reportIssues(report)) {
      if (issue.tone !== 'info' && issue.tone !== 'warning' && issue.tone !== 'bad') continue
      if (rank[issue.tone] < rank[section.minTone]) continue
      const url = issue.href ? (input.resolveUrl?.(issue.href) ?? issue.href) : undefined
      items.push({
        key: `${section.source}:${repoKeyOf(record.repo)}:${issue.id}`,
        repo: record.repo,
        title: issue.title,
        ...(issue.detail && { detail: issue.detail }),
        ...(url && { url }),
        tone: issue.tone,
      })
    }
  }
  return { label: kind.label, items, repos: records.length }
}

/**
 * Builds a digest from the latest analyses: per section, the issues of that analysis kind's
 * reports in the scope at `minTone` or above, most serious first, then by repository. With
 * `onlyNew` items the previous digest listed are left out (they still count in `keys`, so an issue
 * that stays is reported once). Kinds the server does not know give empty sections.
 */
export function buildDigest(input: BuildDigestInput): DigestResult {
  const keys = new Set<string>()
  const sections = input.digest.sections.map((section): DigestSectionResult => {
    const { label, items, repos } = sectionItems(section, input)
    for (const item of items) keys.add(item.key)
    const fresh = input.digest.onlyNew
      ? items.filter((item) => !input.previousKeys?.has(item.key))
      : items
    const sorted = fresh.toSorted(
      (a, b) =>
        rank[b.tone] - rank[a.tone] ||
        repoKeyOf(a.repo).localeCompare(repoKeyOf(b.repo)) ||
        a.title.localeCompare(b.title),
    )
    return {
      source: section.source,
      label,
      items: sorted.slice(0, section.limit),
      total: sorted.length,
      repos,
    }
  })
  return {
    digestId: input.digest.id,
    builtAt: input.now.toISOString(),
    sections,
    empty: sections.every((section) => section.total === 0),
    keys: [...keys].toSorted(),
  }
}

const worst = (result: DigestResult): CardTone => {
  const tones = result.sections.flatMap((section) => section.items.map((item) => item.tone))
  if (tones.includes('bad')) return 'bad'
  if (tones.includes('warning')) return 'warning'
  return tones.length ? 'info' : 'good'
}

/**
 * The digest as a chat card: the name with the most serious tone, a line on what it covers, then
 * per section a heading with its counts and the items (`path · title — detail`, linked) and how
 * many more there are. Sections without items are listed in one line at the end.
 */
export function digestCard(
  digest: Pick<Digest, 'name' | 'onlyNew'>,
  result: DigestResult,
  options: { url?: string; subtitle?: string } = {},
): Card {
  const filled = result.sections.filter((section) => section.total > 0)
  const quiet = result.sections.filter((section) => section.total === 0)
  const blocks: CardBlock[] = []
  if (options.subtitle) blocks.push({ type: 'context', text: options.subtitle })
  if (filled.length === 0)
    blocks.push({
      type: 'text',
      text: digest.onlyNew ? 'Nothing new needs attention.' : 'Nothing needs attention.',
    })
  for (const section of filled) {
    const repos = new Set(section.items.map((item) => repoKeyOf(item.repo))).size
    blocks.push({
      type: 'text',
      text: `**${section.label}** · ${section.total} ${digest.onlyNew ? 'new ' : ''}${
        section.total === 1 ? 'item' : 'items'
      } in ${repos} ${repos === 1 ? 'repository' : 'repositories'}`,
    })
    blocks.push({
      type: 'list',
      items: section.items.map((item) => ({
        text: `\`${item.repo.path}\` · ${item.title}${item.detail ? ` — ${item.detail}` : ''}`,
        tone: item.tone,
        ...(item.url && { url: item.url }),
      })),
    })
    if (section.total > section.items.length)
      blocks.push({ type: 'context', text: `and ${section.total - section.items.length} more` })
  }
  if (quiet.length && filled.length)
    blocks.push({
      type: 'context',
      text: `All clear: ${quiet.map((section) => section.label).join(', ')}`,
    })
  return {
    title: digest.name,
    tone: worst(result),
    ...(options.url && { url: options.url }),
    blocks,
  }
}
