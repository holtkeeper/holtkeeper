import { slackLimits, toMrkdwn } from '@holtkeeper/notify'

import type { SlackMessageBody } from './client.ts'

/** Slack refuses messages with more blocks than this. */
export const SLACK_MAX_BLOCKS = 50
/** Slack refuses section blocks with longer text. */
export const SLACK_MAX_SECTION = slackLimits.section
const FILE_LINKS = 3

/** A link as an announcement shows it; without `url` only the label. */
interface AnnouncementLink {
  label: string
  url?: string
}

/** One connected repository an upgrade breaks. */
export interface AffectedRepository {
  repo: AnnouncementLink
  /** Versions of the package the repository is on now, highest first. */
  versions: string[]
  /** Uses the upgrade breaks. */
  uses: number
  /** Exports those uses go through. */
  exports: string[]
  files: AnnouncementLink[]
}

/**
 * The "Will break on upgrade" block of one version: the repositories it breaks, or
 * `{ affected: [] }` when the API diff is breaking but no connected repository uses what broke.
 * Versions whose diff breaks nothing carry no impact at all.
 */
export interface AnnouncementImpact {
  affected: AffectedRepository[]
  /** Affected repositories of other teams the channel may not name (`access.crossTeam: off`). */
  hidden?: number
  /** No connected repository has usage data yet, so nothing can be said about them. */
  noUsageData?: boolean
}

/** One package (or repository) version of an announcement. */
export interface AnnouncedVersion {
  /** Package name, or the repository for repositories without package tags. */
  title: string
  version: string
  previous?: string
  compareUrl?: string
  overview?: string
  highlights?: string[]
  /** Breaking changes with migration hints. */
  breaking?: { change: string; migration?: string }[]
  /** Commits grouped by changelog section, in section order. */
  sections: { title: string; items: AnnouncementLink[] }[]
  tasks?: AnnouncementLink[]
  impact?: AnnouncementImpact
}

/** Everything one announcement shows. */
export interface AnnouncementContent {
  /** The repository, e.g. `acme/widgets`. */
  repo: string
  versions: AnnouncedVersion[]
  /** The API index of a version is not there yet: impact follows in an update. */
  impactPending?: boolean
  /** The API index never arrived: impact is left out for good. */
  impactUnavailable?: boolean
  /** Holtkeeper's release page, where truncated lists continue. */
  releaseUrl?: string
}

/** Text with Slack's control characters escaped, for mrkdwn. */
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** A URL inside `<url|label>`: Slack's control characters escaped, `|` percent-encoded. */
const href = (url: string) => escape(url).replaceAll('|', '%7C')

const linkTo = (url: string, label: string) => `<${href(url)}|${label.replaceAll('|', '¦')}>`

const linkText = (link: AnnouncementLink) =>
  link.url ? linkTo(link.url, escape(link.label)) : escape(link.label)

const code = (text: string) => `\`${text.replaceAll('`', "'")}\``

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The first `max` characters of a mrkdwn line, never ending inside a `<url|label>` link. */
function cutLine(line: string, max: number): string {
  const cut = line.slice(0, max)
  const open = cut.lastIndexOf('<')
  return open > cut.lastIndexOf('>') ? cut.slice(0, open) : cut
}

/**
 * `title` and as many `lines` as fit in one section; the rest become one `…and N more` line,
 * linking to `moreUrl` when given. A single line longer than the limit is cut.
 */
export function fitSection(
  title: string,
  lines: readonly string[],
  moreUrl?: string,
  max = SLACK_MAX_SECTION,
): string {
  const head = title ? `*${title}*` : ''
  const join = (kept: readonly string[], more: number) =>
    [
      ...(head ? [head] : []),
      ...kept,
      ...(more > 0
        ? [`…and ${more} more${moreUrl ? ` in ${linkTo(moreUrl, 'Holtkeeper')}` : ''}`]
        : []),
    ].join('\n')
  const kept: string[] = []
  for (const [index, line] of lines.entries()) {
    const next = [...kept, line]
    const rest = lines.length - index - 1
    if (join(next, rest).length <= max) {
      kept.push(line)
      continue
    }
    const room = max - join([], rest).length - 2
    if (kept.length === 0 && room > 20) kept.push(`${cutLine(line, room)}…`)
    return join(kept, lines.length - kept.length)
  }
  return join(kept, 0)
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })
const context = (text: string) => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: text.slice(0, SLACK_MAX_SECTION) }],
})

const headerText = (text: string) =>
  text.length > slackLimits.header ? `${text.slice(0, slackLimits.header - 1)}…` : text

/** AI prose (Markdown-ish) as mrkdwn on one line: `**bold**`, `[label](url)` converted. */
const prose = (text: string) => toMrkdwn(text.replaceAll(/\s*\n\s*/gu, ' '))

const impactLines = (impact: AnnouncementImpact) => [
  ...impact.affected.map((repo) => {
    const on = repo.versions.length ? ` (on ${repo.versions.join(', ')})` : ''
    const exports = repo.exports.slice(0, 5).map(code).join(', ')
    const moreExports = repo.exports.length > 5 ? ` and ${repo.exports.length - 5} more` : ''
    const files = repo.files.slice(0, FILE_LINKS).map(linkText).join(', ')
    return `• ${linkText(repo.repo)}${on}: ${plural(repo.uses, 'broken use')} of ${exports}${moreExports}${files ? ` — ${files}` : ''}`
  }),
  ...(impact.hidden
    ? [`• ${impact.hidden} ${impact.hidden === 1 ? 'repository' : 'repositories'} of other teams`]
    : []),
]

const impactText = (impact: AnnouncementImpact, more: string | undefined) => {
  if (impact.affected.length || impact.hidden)
    return fitSection('Will break on upgrade', impactLines(impact), more)
  return impact.noUsageData
    ? '*Will break on upgrade*\nNo usage data from connected repositories yet.'
    : '*Will break on upgrade*\nNo connected repository is affected.'
}

function versionBlocks(
  version: AnnouncedVersion,
  content: AnnouncementContent,
  several: boolean,
): Record<string, unknown>[] {
  const more = content.releaseUrl
  const blocks: Record<string, unknown>[] = []
  const since = [
    ...(version.previous ? [`since ${escape(version.previous)}`] : []),
    ...(version.compareUrl ? [linkTo(version.compareUrl, 'Compare')] : []),
  ].join(' · ')
  if (several)
    blocks.push(
      section(
        `*${escape(version.title)} ${escape(version.version)}*${since ? `  ${since}` : ''}`.slice(
          0,
          SLACK_MAX_SECTION,
        ),
      ),
    )
  else if (since) blocks.push(context(since))
  if (version.overview || version.highlights?.length)
    blocks.push(
      section(
        fitSection(
          '',
          [
            ...(version.overview ? [prose(version.overview)] : []),
            ...(version.highlights ?? []).map((item) => `• ${prose(item)}`),
          ],
          more,
        ),
      ),
    )
  if (version.breaking?.length)
    blocks.push(
      section(
        fitSection(
          'Breaking changes',
          version.breaking.map(
            (item) =>
              `• ${prose(item.change)}${item.migration ? `\n    _${prose(item.migration)}_` : ''}`,
          ),
          more,
        ),
      ),
    )
  const changes = version.sections.flatMap((group) => [
    `_${escape(group.title)}_`,
    ...group.items.map((item) => `• ${linkText(item)}`),
  ])
  if (changes.length) blocks.push(section(fitSection('Changes', changes, more)))
  if (version.tasks?.length)
    blocks.push(
      section(
        fitSection(
          'Tasks',
          version.tasks.map((t) => `• ${linkText(t)}`),
          more,
        ),
      ),
    )
  if (version.impact) blocks.push(section(impactText(version.impact, more)))
  return blocks
}

/**
 * The Slack message of an announcement: a header with the package (or repository) and version,
 * then per version its notes, breaking changes, commits by section, tasks and the repositories an
 * upgrade breaks; several versions get one section each. Every section stays within Slack's 3000
 * characters and the message within 50 blocks: lists are cut with `…and N more`, linking to
 * `releaseUrl` when given, and versions that do not fit are counted in a last line.
 */
export function announcementMessage(content: AnnouncementContent): SlackMessageBody {
  const several = content.versions.length > 1
  const first = content.versions[0]
  const title =
    several || !first ? `New versions in ${content.repo}` : `${first.title} ${first.version}`
  const tail: Record<string, unknown>[] = []
  if (content.impactPending) tail.push(context('Compatibility analysis is still running'))
  else if (content.impactUnavailable) tail.push(context('Compatibility analysis is unavailable'))
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText(title), emoji: false } },
  ]
  const room = SLACK_MAX_BLOCKS - tail.length - 1
  let shown = 0
  for (const version of content.versions) {
    const own = [
      ...(several && shown > 0 ? [{ type: 'divider' }] : []),
      ...versionBlocks(version, content, several),
    ]
    if (blocks.length + own.length > room) break
    blocks.push(...own)
    shown++
  }
  const left = content.versions.length - shown
  if (left > 0)
    blocks.push(
      section(
        `…and ${plural(left, 'more version')}${content.releaseUrl ? ` in ${linkTo(content.releaseUrl, 'Holtkeeper')}` : ''}`,
      ),
    )
  blocks.push(...tail)
  const text = several
    ? `${title}: ${content.versions.map((version) => `${version.title} ${version.version}`).join(', ')}`
    : `${title} released`
  return { text: text.slice(0, 3000), blocks }
}
