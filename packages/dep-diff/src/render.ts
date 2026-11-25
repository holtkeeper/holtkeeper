import { inRoot } from './shared.ts'
import type {
  DependencyDiff,
  DependencyRoot,
  DependencySide,
  DirectDependencyChange,
  TransitiveDependencyChange,
} from './types.ts'

const DEFAULT_MAX_DIRECT = 30
const DEFAULT_MAX_TRANSITIVE = 20

const sideText = (side: DependencySide | undefined) => {
  if (!side) return '?'
  if (side.range !== undefined && side.version !== undefined && side.range !== side.version)
    return `${side.range} (${side.version})`
  return side.range ?? side.version ?? '?'
}

function directLine(change: DirectDependencyChange, ecosystem: DependencyRoot['ecosystem']) {
  const where = ecosystem === 'npm' && change.workspace !== '.' ? `, ${change.workspace}` : ''
  const tag = ` (${change.field}${where})`
  if (change.change === 'added') return `- added \`${change.name}\` ${sideText(change.to)}${tag}`
  if (change.change === 'removed')
    return `- removed \`${change.name}\` ${sideText(change.from)}${tag}`
  return `- \`${change.name}\` ${sideText(change.from)} → ${sideText(change.to)}${tag}`
}

const versions = (list: readonly string[] | undefined) => (list ?? []).join(', ')

function transitiveText(change: TransitiveDependencyChange) {
  if (change.change === 'updated')
    return `${change.name} ${versions(change.from)} → ${versions(change.to)}`
  return `${change.name} ${versions(change.change === 'added' ? change.to : change.from)}`
}

function rootLines(root: DependencyRoot, maxDirect: number, maxTransitive: number): string[] {
  const file = root.ecosystem === 'go' ? 'go.mod' : (root.lockfile ?? 'package.json')
  const out = [`### ${inRoot(root.path, file)} (${root.manager ?? root.ecosystem})`]
  const { counts } = root
  out.push(
    `Direct: ${counts.added} added, ${counts.updated} updated, ${counts.removed} removed. Transitive: ${counts.transitiveAdded} added, ${counts.transitiveUpdated} updated, ${counts.transitiveRemoved} removed.`,
  )
  const direct = root.direct.map((change) => directLine(change, root.ecosystem))
  out.push(...direct.slice(0, maxDirect))
  if (direct.length > maxDirect) out.push(`- … ${direct.length - maxDirect} more direct changes`)
  const total = counts.transitiveAdded + counts.transitiveRemoved + counts.transitiveUpdated
  if (total && maxTransitive > 0) {
    const shown = root.transitive.slice(0, maxTransitive).map(transitiveText)
    out.push(
      `Transitive: ${shown.join('; ')}${total > shown.length ? `; … ${total - shown.length} more` : ''}`,
    )
  }
  for (const error of root.errors) out.push(`- error: ${error}`)
  return out
}

/**
 * Compact Markdown of a dependency diff: one `###` block per root with counts, the direct changes
 * (`maxDirect` at most) and a one-line sample of transitive changes (`maxTransitive` at most), then
 * notes on skipped roots and an incomplete file list. `''` when there are no roots.
 */
export function renderDependencyDiff(
  diff: DependencyDiff,
  options: { maxDirect?: number; maxTransitive?: number } = {},
): string {
  if (!diff.roots.length) return ''
  const maxDirect = options.maxDirect ?? DEFAULT_MAX_DIRECT
  const maxTransitive = options.maxTransitive ?? DEFAULT_MAX_TRANSITIVE
  const blocks = diff.roots.map((root) => rootLines(root, maxDirect, maxTransitive).join('\n'))
  const notes: string[] = []
  if (diff.skipped) notes.push(`${diff.skipped} more dependency roots were not computed.`)
  if (diff.partial) notes.push('The changed file list was incomplete; some roots may be missing.')
  return [...blocks, ...(notes.length ? [notes.join(' ')] : [])].join('\n\n')
}
