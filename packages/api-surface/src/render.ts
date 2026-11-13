import { defaultPackageName } from '@holtkeeper/go-source'

import type { PackageDiff } from './diff.ts'
import type { ApiEcosystem, ApiPackage, ApiSymbol } from './model.ts'

/**
 * The specifier code imports an entry with, e.g. `@acme/ui/button` for subpath `./button`. For a
 * Go module and a package subpath it is the package's import path.
 */
export const importPath = (pkg: string, subpath: string) =>
  subpath === '.' ? pkg : `${pkg}/${subpath.replace(/^\.\//, '')}`

/** Code fence language of an ecosystem's declarations: `go` for Go, `ts` otherwise. */
export const fenceLanguage = (ecosystem: ApiEcosystem | undefined) =>
  ecosystem === 'Go' ? 'go' : 'ts'

const fence = (code: string, ecosystem?: ApiEcosystem) => {
  const ticks = code.includes('```') ? '````' : '```'
  return `${ticks}${fenceLanguage(ecosystem)}\n${code}\n${ticks}`
}

/**
 * One symbol as Markdown: heading, deprecation, doc comment and declaration, fenced as Go when
 * `ecosystem` is `Go`, else as TypeScript.
 */
export function renderSymbol(
  symbol: ApiSymbol,
  options: { docs?: boolean; ecosystem?: ApiEcosystem } = {},
): string {
  const lines = [`### ${symbol.name} (${symbol.kind})`]
  if (symbol.deprecated !== undefined)
    lines.push(`**Deprecated**${symbol.deprecated ? `: ${symbol.deprecated}` : ''}`)
  if (options.docs !== false && symbol.doc) lines.push(symbol.doc)
  lines.push(
    fence(symbol.signature, options.ecosystem),
    `Source: \`${symbol.file}:${symbol.line}\``,
  )
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

const internalRoot = (path: string) => {
  const segments = path.split('/')
  return segments.slice(0, segments.lastIndexOf('internal')).join('/')
}

function goUsage(pkg: ApiPackage): string {
  const name = defaultPackageName(pkg.name)
  const module = pkg.module && pkg.module !== pkg.name ? ` of module \`${pkg.module}\`` : ''
  const internal = pkg.private
    ? ` Internal package: only code inside \`${internalRoot(pkg.name)}\` can import it.`
    : ''
  return `Go package${module}. Import it with \`import "${pkg.name}"\` and refer to its names as \`${name}.Name\`; methods are listed as \`Type.Method\`.${internal}`
}

/**
 * A package's public API as one Markdown document for LLM agents: what to import from where,
 * every exported name with its doc comment and declaration. Go packages also say how to import
 * them and fence declarations as Go. `subpath` limits it to one entry, `docs: false` leaves doc
 * comments out for a compact overview.
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
    ...(pkg.ecosystem === 'Go' ? [goUsage(pkg)] : []),
  ].filter(Boolean)
  const entries = pkg.entries.filter(
    (entry) => !options.subpath || entry.subpath === options.subpath,
  )
  const sections = entries.map((entry) => {
    const lines = [
      `## \`${importPath(pkg.name, entry.subpath)}\``,
      `${entry.symbols.length} export${entry.symbols.length === 1 ? '' : 's'}${entry.file ? ` from \`${entry.file}\`` : ''}${entry.truncated ? `, ${entry.truncated} more not listed` : ''}.`,
      ...entry.symbols.map((symbol) =>
        renderSymbol(symbol, { ...options, ecosystem: pkg.ecosystem }),
      ),
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
      lines.push(
        `Before:\n\n${fence(change.before, diff.ecosystem)}`,
        `After:\n\n${fence(change.after, diff.ecosystem)}`,
      )
    else {
      const code = change.after ?? change.before
      if (code) lines.push(fence(code, diff.ecosystem))
    }
  }
  return lines.join('\n\n')
}
