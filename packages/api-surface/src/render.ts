import type { PackageDiff } from './diff.ts'
import type { ApiPackage, ApiSymbol } from './model.ts'

/** The specifier code imports an entry with, e.g. `@acme/ui/button` for subpath `./button`. */
export const importPath = (pkg: string, subpath: string) =>
  subpath === '.' ? pkg : `${pkg}/${subpath.replace(/^\.\//, '')}`

const fence = (code: string) => {
  const ticks = code.includes('```') ? '````' : '```'
  return `${ticks}ts\n${code}\n${ticks}`
}

/** One symbol as Markdown: heading, deprecation, doc comment and declaration. */
export function renderSymbol(symbol: ApiSymbol, options: { docs?: boolean } = {}): string {
  const lines = [`### ${symbol.name} (${symbol.kind})`]
  if (symbol.deprecated !== undefined)
    lines.push(`**Deprecated**${symbol.deprecated ? `: ${symbol.deprecated}` : ''}`)
  if (options.docs !== false && symbol.doc) lines.push(symbol.doc)
  lines.push(fence(symbol.signature), `Source: \`${symbol.file}:${symbol.line}\``)
  return lines.join('\n\n')
}

/** What `renderPackage` puts in its header besides the package itself. */
export interface RenderContext {
  /** `forge:path` of the repository. */
  repo?: string
  /** Release, tag or commit the analysis describes. */
  ref?: string
  analyzedAt?: string
}

/**
 * A package's public API as one Markdown document for LLM agents: what to import from where,
 * every exported name with its doc comment and declaration. `subpath` limits it to one entry,
 * `docs: false` leaves doc comments out for a compact overview.
 */
export function renderPackage(
  pkg: ApiPackage,
  options: RenderContext & { subpath?: string; docs?: boolean } = {},
): string {
  const header = [
    `# ${pkg.name}${pkg.version ? `@${pkg.version}` : ''}`,
    ...(pkg.description ? [pkg.description] : []),
    [
      options.repo ? `Repository: \`${options.repo}\`` : '',
      pkg.dir !== '.' ? `folder \`${pkg.dir}\`` : '',
      options.ref ? `ref \`${options.ref}\`` : '',
      options.analyzedAt ? `analyzed ${options.analyzedAt}` : '',
    ]
      .filter(Boolean)
      .join(', '),
  ].filter(Boolean)
  const entries = pkg.entries.filter(
    (entry) => !options.subpath || entry.subpath === options.subpath,
  )
  const sections = entries.map((entry) => {
    const lines = [
      `## \`${importPath(pkg.name, entry.subpath)}\``,
      `${entry.symbols.length} export${entry.symbols.length === 1 ? '' : 's'}${entry.file ? ` from \`${entry.file}\`` : ''}${entry.truncated ? `, ${entry.truncated} more not listed` : ''}.`,
      ...entry.symbols.map((symbol) => renderSymbol(symbol, options)),
    ]
    return lines.join('\n\n')
  })
  return [...header, ...sections].join('\n\n')
}

/** Changes between two versions of a package as Markdown, removals first. */
export function renderDiff(diff: PackageDiff): string {
  const lines = [
    `# ${diff.name}: ${diff.from ?? 'new'} → ${diff.to ?? 'removed'}`,
    `${diff.removed} removed, ${diff.changed} changed, ${diff.deprecated} deprecated, ${diff.added} added. Calls for a ${diff.required} release${diff.bumped ? `; the version got a ${diff.bumped} bump` : ''}.`,
    ...(diff.semverWarning ? [`**Semver:** ${diff.semverWarning}.`] : []),
  ]
  for (const change of diff.changes) {
    const name = `${importPath(diff.name, change.subpath)} → ${change.name}`
    lines.push(`## ${change.change}: \`${name}\` (${change.kind})`)
    if (change.change === 'changed' && change.before && change.after)
      lines.push(`Before:\n\n${fence(change.before)}`, `After:\n\n${fence(change.after)}`)
    else {
      const code = change.after ?? change.before
      if (code) lines.push(fence(code))
    }
  }
  return lines.join('\n\n')
}
