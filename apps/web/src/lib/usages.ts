import type { ImpactLevel, NameCount, UsageKind, UsageSite } from '@holtkeeper/api'

/** How a member path reads after the export, e.g. `.reset` or `().reset`. */
export const memberLabel = (member: string) => (member.startsWith('()') ? member : `.${member}`)

/** Short words for how code uses an export. */
export const usageKindLabels: Record<UsageKind, string> = {
  call: 'call',
  new: 'new',
  jsx: 'JSX',
  member: 'member',
  type: 'type',
  extends: 'extends',
  reexport: 're-export',
  reference: 'reference',
  import: 'import only',
}

/** Chip tone of an upgrade impact level. */
export const impactTone: Record<ImpactLevel, 'danger' | 'warning' | 'default'> = {
  breaking: 'danger',
  check: 'warning',
  deprecated: 'default',
}

/** Snippet lines with their numbers; `focus` marks the line of the use. */
export function snippetLines(site: Pick<UsageSite, 'snippet' | 'snippetLine' | 'line'>) {
  return site.snippet.split('\n').map((text, index) => ({
    number: site.snippetLine + index,
    text,
    focus: site.snippetLine + index === site.line,
  }))
}

/** Kinds of use as `kind count` pairs, most frequent first. */
export const kindCounts = (kinds: Partial<Record<UsageKind, number>>) =>
  Object.keys(kinds)
    .filter((kind): kind is UsageKind => kind in usageKindLabels)
    .map((kind) => ({ kind, count: kinds[kind] ?? 0 }))
    .toSorted((a, b) => b.count - a.count)

/** Share of uses per name, in percent of the largest, for drawing bars. */
export const relativeCounts = (items: readonly NameCount[]) => {
  const max = Math.max(1, ...items.map((item) => item.count))
  return items.map((item) => ({ ...item, share: Math.round((item.count / max) * 100) }))
}
