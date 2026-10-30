import type { FoundSite, PackageUsage, UpgradeImpact } from './fleet.ts'
import { type UsageSite, importPath } from './model.ts'

const languageOf = (file: string) => (/\.[mc]?tsx?$/.test(file) ? 'tsx' : 'jsx')

const counts = (items: readonly { name: string; count: number }[], limit = 12) =>
  items
    .slice(0, limit)
    .map((item) => `\`${item.name}\` ×${item.count}`)
    .join(', ') + (items.length > limit ? `, …${items.length - limit} more` : '')

/** One site as Markdown: location, how it is used and its snippet. */
export function renderSite(site: UsageSite, label?: string): string {
  const how = [
    site.kind,
    site.member ? `\`.${site.member.replace(/^\(\)/, '()')}\`` : '',
    site.props?.length ? `props ${site.props.map((p) => `\`${p}\``).join(', ')}` : '',
    site.spread ? '`{...spread}`' : '',
    site.typed ? '(via types)' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return [
    `${label ? `${label} ` : ''}\`${site.file}:${site.line}\` — ${how}`,
    `\`\`\`${languageOf(site.file)}\n${site.snippet}\n\`\`\``,
  ].join('\n')
}

/** Who uses a package and which parts of it, as Markdown for agents. */
export function renderPackageUsage<Origin>(
  usage: PackageUsage<Origin>,
  options: { originLabel: (origin: Origin) => string; exports?: number } = {
    originLabel: String,
  },
): string {
  if (!usage.repos.length) return `No analyzed repository uses ${usage.name}.`
  const label = options.originLabel
  const lines = [
    `# ${usage.name}: ${usage.repos.length} repositor${usage.repos.length === 1 ? 'y' : 'ies'}`,
    `Versions in use: ${usage.versions.join(', ') || 'unknown'}.`,
    '',
    '## Repositories',
    ...usage.repos.map(
      (repo) =>
        `- \`${label(repo.origin)}\` — ${repo.versions.join(', ') || repo.ranges.join(', ') || 'version unknown'}, ${repo.count} uses in ${repo.files} files, ${repo.exports.length} exports${repo.workspaces.length > 1 || repo.workspaces[0] !== 'root' ? ` (workspaces ${repo.workspaces.join(', ')})` : ''}`,
    ),
    '',
    '## Exports used',
  ]
  const limit = options.exports ?? 60
  for (const item of usage.exports.slice(0, limit)) {
    const kinds = Object.entries(item.kinds)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(', ')
    lines.push(
      `- **${item.name}** from \`${importPath(usage.name, item.subpath)}\` — ${item.count} uses in ${item.repos.length} repos (${kinds})`,
    )
    if (item.props.length) lines.push(`  props: ${counts(item.props)}`)
    if (item.members.length) lines.push(`  members: ${counts(item.members)}`)
  }
  if (usage.exports.length > limit)
    lines.push(`…and ${usage.exports.length - limit} more exports; pass \`export\` to find_usages.`)
  return lines.join('\n')
}

/** Sites with snippets, grouped by repository, as Markdown. */
export function renderSites<Origin>(
  found: { sites: FoundSite<Origin>[]; total: number; more: number },
  originLabel: (origin: Origin) => string = String,
): string {
  if (!found.sites.length) return 'No matching use.'
  const lines: string[] = []
  let current: Origin | undefined
  for (const item of found.sites) {
    if (item.origin !== current) {
      current = item.origin
      lines.push(
        `## \`${originLabel(item.origin)}\`${item.versions.length ? ` (${item.versions.join(', ')})` : ''}`,
      )
    }
    lines.push(renderSite(item.site, `**${item.export}**`))
  }
  const shown = found.sites.length
  if (found.more || found.total > shown)
    lines.push(
      `Showing ${shown} of ${Math.max(found.total, shown + found.more)} uses; records keep a sample of sites per export.`,
    )
  return lines.join('\n\n')
}

/** What an upgrade breaks, as Markdown for agents planning a migration. */
export function renderImpact<Origin>(
  impact: UpgradeImpact<Origin>,
  originLabel: (origin: Origin) => string = String,
): string {
  if (!impact.items.length)
    return `No analyzed use of ${impact.package} is affected by these changes${impact.unaffected.length ? ` (${impact.unaffected.length} repositories use the package)` : ''}.`
  const lines = [
    `# Upgrading ${impact.package}`,
    `Affected repositories: ${impact.affected.map((o) => `\`${originLabel(o)}\``).join(', ')}.`,
    ...(impact.unaffected.length
      ? [`Unaffected: ${impact.unaffected.map((o) => `\`${originLabel(o)}\``).join(', ')}.`]
      : []),
  ]
  for (const item of impact.items) {
    lines.push(
      '',
      `## ${item.level}: ${item.change.change} \`${importPath(impact.package, item.change.subpath)}\` → ${item.change.name} (${item.count} uses)`,
    )
    if (item.removedMembers?.length)
      lines.push(`Members removed: ${item.removedMembers.map((m) => `\`${m}\``).join(', ')}.`)
    if (item.change.before) lines.push(`Before:\n\`\`\`ts\n${item.change.before}\n\`\`\``)
    if (item.change.after) lines.push(`After:\n\`\`\`ts\n${item.change.after}\n\`\`\``)
    for (const repo of item.repos) {
      lines.push(
        `### \`${originLabel(repo.origin)}\` (${repo.versions.join(', ') || 'version unknown'}) — ${repo.count} uses${repo.via ? ` through ${repo.via}` : ''}${repo.members ? `, touching ${repo.members.map((m) => `\`${m}\``).join(', ')}` : ''}`,
      )
      for (const site of repo.sites) lines.push(renderSite(site))
    }
  }
  return lines.join('\n\n')
}
