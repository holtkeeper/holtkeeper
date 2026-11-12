import type {
  ApiSymbol,
  ApiSymbolKind,
  PublicApiMatch,
  PublicApiPackageSummary,
  PublicApiSymbolChange,
  PublicApiSymbolHit,
  PublicApiVersion,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { formatRef } from './format.ts'
import { searchEntry, searchEnum, searchText } from './search-params.ts'

/** Views of the Public API page: the package catalog, or symbol search. */
export type PublicApiTab = 'packages' | 'search'

/** Sort orders of symbol search besides the default, best match first. */
type PublicApiSort = 'name' | 'package'

/** Which records a hit may come from: a release, or a default branch run. */
export type PublicApiRef = 'release' | 'head'

/** Tabs of the symbol sheet. */
export type PublicApiPane = 'declaration' | 'history'

/** Search parameters of `/supply/public-api`; omitted keys are the defaults. */
export interface PublicApiSearch {
  /** Symbol search when `q` is set, else the catalog, unless chosen. */
  tab?: PublicApiTab
  /** Search text: symbol names and doc words, or package names in the catalog. */
  q?: string
  sort?: PublicApiSort
  /** Facets: package name, repository (`forge:path`), entry point, kind and match. */
  package?: string
  repo?: string
  subpath?: string
  kind?: ApiSymbolKind
  match?: PublicApiMatch
  ref?: PublicApiRef
  /** Include deprecated symbols and packages their repository removed. */
  deprecated?: true
  removed?: true
  /** Version the symbol sheet reads; the newest record when omitted. */
  version?: string
  /** The symbol open in the sheet, as `symbolKey` writes it. */
  symbol?: string
  pane?: PublicApiPane
}

const symbolKindValues: readonly ApiSymbolKind[] = [
  'function',
  'class',
  'variable',
  'interface',
  'type',
  'enum',
  'namespace',
  'reexport',
]

const flag = (value: unknown) => (value === true || value === 'true' ? (true as const) : undefined)

/** Reads `/supply/public-api` search parameters, dropping unknown values and defaults. */
export function parsePublicApiSearch(search: Record<string, unknown>): PublicApiSearch {
  return {
    ...searchEntry('tab', searchEnum(search.tab, ['packages', 'search'] as const)),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('sort', searchEnum(search.sort, ['name', 'package'] as const)),
    ...searchEntry('package', searchText(search.package)),
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('subpath', searchText(search.subpath)),
    ...searchEntry('kind', searchEnum(search.kind, symbolKindValues)),
    ...searchEntry('match', searchEnum(search.match, ['exact', 'prefix', 'part', 'doc'] as const)),
    ...searchEntry('ref', searchEnum(search.ref, ['release', 'head'] as const)),
    ...searchEntry('deprecated', flag(search.deprecated)),
    ...searchEntry('removed', flag(search.removed)),
    ...searchEntry('version', searchText(search.version)),
    ...searchEntry('symbol', searchText(search.symbol)),
    ...searchEntry('pane', searchEnum(search.pane, ['declaration', 'history'] as const)),
  }
}

/** The view a search shows: the chosen one, else symbol search while there is search text. */
export const publicApiTab = (search: Pick<PublicApiSearch, 'tab' | 'q'>): PublicApiTab =>
  search.tab ?? (search.q ? 'search' : 'packages')

/** Kinds in the order the package view lists them, with their headings. */
export const symbolKinds: readonly { kind: ApiSymbolKind; label: string }[] = [
  { kind: 'function', label: 'Functions' },
  { kind: 'class', label: 'Classes' },
  { kind: 'variable', label: 'Constants' },
  { kind: 'interface', label: 'Interfaces' },
  { kind: 'type', label: 'Types' },
  { kind: 'enum', label: 'Enums' },
  { kind: 'namespace', label: 'Namespaces' },
  { kind: 'reexport', label: 'Re-exports' },
]

/** Symbols matching `query` (name or doc, case-insensitive), grouped by kind in `symbolKinds` order. */
export function groupSymbols(
  symbols: readonly ApiSymbol[],
  query = '',
): { kind: ApiSymbolKind; label: string; symbols: ApiSymbol[] }[] {
  const needle = query.trim().toLowerCase()
  const matching = needle
    ? symbols.filter(
        (symbol) =>
          symbol.name.toLowerCase().includes(needle) || symbol.doc?.toLowerCase().includes(needle),
      )
    : symbols
  return symbolKinds
    .map(({ kind, label }) => ({
      kind,
      label,
      symbols: matching.filter((symbol) => symbol.kind === kind),
    }))
    .filter((group) => group.symbols.length > 0)
}

/** How a version reads in pickers: `1.4.0 · @acme/ui@1.4.0`, `head · 1.5.0-dev`. */
export function versionLabel(version: PublicApiVersion): string {
  if (version.head) return `head · ${version.version}`
  const ref = version.ref
  return ref && ref !== version.version && ref !== `v${version.version}`
    ? `${version.version} · ${formatRef(ref)}`
    : version.version
}

/** Value of a version in pickers and links: `head` for the default branch, else the version. */
export const versionKey = (version: PublicApiVersion) => (version.head ? 'head' : version.version)

/** Share of exports with a doc comment, rounded; `undefined` without exports. */
export const documentedShare = (documented: number, exports: number) =>
  exports ? Math.round((documented / exports) * 100) : undefined

/** Tone of a documented share: 80% or more green, 40 to 79% amber, less red. */
export const documentedTone = (share: number): StatusTone =>
  share >= 80 ? 'success' : share >= 40 ? 'warning' : 'danger'

/** Figures over catalog packages for the summary strip. */
export function catalogTotals(packages: readonly PublicApiPackageSummary[]) {
  const exports = packages.reduce((sum, pkg) => sum + pkg.exports, 0)
  return {
    packages: packages.length,
    repos: new Set(packages.map((pkg) => `${pkg.repo.forge}:${pkg.repo.path}`)).size,
    exports,
    documented: documentedShare(
      packages.reduce((sum, pkg) => sum + pkg.documented, 0),
      exports,
    ),
    versions: packages.reduce((sum, pkg) => sum + pkg.versions, 0),
  }
}

/** The package and entry point an import specifier names: `@acme/ui/button` is `@acme/ui`, `./button`. */
export function splitImportPath(importPath: string): { package: string; subpath: string } {
  const parts = importPath.split('/')
  const size = importPath.startsWith('@') ? 2 : 1
  const rest = parts.slice(size).join('/')
  return { package: parts.slice(0, size).join('/'), subpath: rest ? `./${rest}` : '.' }
}

/** How the `symbol` search parameter names a hit: `<import path>:<name>`. */
export const symbolKey = (hit: Pick<PublicApiSymbolHit, 'importPath' | 'symbol'>): string =>
  `${hit.importPath}:${hit.symbol.name}`

/** Reads `symbolKey` back into the package, entry point and name it names. */
export function parseSymbolKey(
  value: string | undefined,
): { package: string; subpath: string; name: string } | undefined {
  const at = value?.lastIndexOf(':') ?? -1
  if (!value || at <= 0 || at === value.length - 1) return undefined
  return { ...splitImportPath(value.slice(0, at)), name: value.slice(at + 1) }
}

/** The filters symbol search applies to its hits on the page. */
export interface HitFilter {
  deprecated?: boolean
  removed?: boolean
  ref?: PublicApiRef
}

const refOf = (hit: Pick<PublicApiSymbolHit, 'ref'>): PublicApiRef => (hit.ref ? 'release' : 'head')

/**
 * Hits without deprecated symbols and removed packages unless included, and from releases or
 * default branch runs only when `ref` says so; `sort` orders by name or package, else the order
 * stays best match first.
 */
export function filterHits(
  hits: readonly PublicApiSymbolHit[],
  filter: HitFilter,
  sort?: PublicApiSort,
): PublicApiSymbolHit[] {
  const kept = hits.filter(
    (hit) =>
      (filter.deprecated || !hit.deprecated) &&
      (filter.removed || !hit.removed) &&
      (!filter.ref || refOf(hit) === filter.ref),
  )
  if (sort === 'name')
    return kept.toSorted(
      (a, b) =>
        a.symbol.name.localeCompare(b.symbol.name) || a.importPath.localeCompare(b.importPath),
    )
  if (sort === 'package')
    return kept.toSorted(
      (a, b) =>
        a.importPath.localeCompare(b.importPath) || a.symbol.name.localeCompare(b.symbol.name),
    )
  return kept
}

/** How many hits are deprecated, from removed packages, from releases and from default branches. */
export function hitCounts(hits: readonly PublicApiSymbolHit[]) {
  return {
    deprecated: hits.filter((hit) => hit.deprecated).length,
    removed: hits.filter((hit) => hit.removed).length,
    release: hits.filter((hit) => refOf(hit) === 'release').length,
    head: hits.filter((hit) => refOf(hit) === 'head').length,
  }
}

/** How a match reads in the hit table and facets. */
export const matchLabels: Record<PublicApiMatch, string> = {
  exact: 'Exact name',
  prefix: 'Prefix',
  part: 'Part of a name',
  doc: 'Doc text',
}

/** A symbol change in words, with its tone. */
export const changeLabels: Record<
  PublicApiSymbolChange['change'],
  { label: string; tone: StatusTone }
> = {
  added: { label: 'Added', tone: 'success' },
  changed: { label: 'Changed', tone: 'warning' },
  deprecated: { label: 'Deprecated', tone: 'warning' },
  removed: { label: 'Removed', tone: 'danger' },
}

/** The first paragraph of a doc comment without its tags, for one-line previews. */
export const docSummary = (doc: string | undefined): string =>
  parseDocTags(doc)
    .summary.split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, ' ')
    .trim() ?? ''

/** A TSDoc / JSDoc comment split into its description and block tags. */
export interface DocTags {
  /** Text before the first block tag; inline `{@link}` tags become code spans. */
  summary: string
  params: { name: string; text: string }[]
  typeParams: { name: string; text: string }[]
  returns?: string
  throws: string[]
  since?: string
  /** Set when `@deprecated` is present, empty when it carries no text. */
  deprecated?: string
  /** Code of each `@example`, as written. */
  examples: string[]
  see: string[]
  /** Any other block tag, e.g. `@remarks` or `@defaultValue`. */
  other: { tag: string; text: string }[]
}

const inlineTags = (text: string) =>
  text.replace(
    /\{@(?:link|linkcode|linkplain)\s+([^\s|}]+)(?:\s*\|\s*|\s+)?([^}]*)\}/g,
    (_, target: string, label: string) => (label.trim() ? label.trim() : `\`${target}\``),
  )

const named = (text: string) => {
  const body = text.replace(/^\{[^}]*\}\s*/, '')
  const match = /^(\[[^\]]*\]|\S+)\s*(?:-\s+)?([\s\S]*)$/.exec(body)
  const name = (match?.[1] ?? body).replace(/^\[([^=\]]+).*\]$/, '$1')
  return { name, text: inlineTags(match?.[2] ?? '').trim() }
}

/**
 * Splits a doc comment into its description and block tags (`@param`, `@returns`, `@throws`,
 * `@since`, `@deprecated`, `@example`, `@see` and the rest). A tag starts a line; lines inside
 * code fences never start one. An absent comment gives an empty description and no tags.
 */
export function parseDocTags(doc: string | undefined): DocTags {
  const result: DocTags = {
    summary: '',
    params: [],
    typeParams: [],
    throws: [],
    examples: [],
    see: [],
    other: [],
  }
  if (!doc) return result
  const blocks: { tag: string; lines: string[] }[] = [{ tag: '', lines: [] }]
  let fenced = false
  for (const line of doc.split('\n')) {
    const tag = fenced ? null : /^\s*@(\w+)\s?(.*)$/.exec(line)
    if (tag) blocks.push({ tag: tag[1]!, lines: [tag[2] ?? ''] })
    else blocks.at(-1)!.lines.push(line)
    if (line.trim().startsWith('```')) fenced = !fenced
  }
  for (const { tag, lines } of blocks) {
    const text = lines.join('\n').trim()
    switch (tag) {
      case '':
        result.summary = inlineTags(text)
        break
      case 'param':
        result.params.push(named(text))
        break
      case 'typeParam':
      case 'template':
        result.typeParams.push(named(text))
        break
      case 'returns':
      case 'return':
        result.returns = inlineTags(text)
        break
      case 'throws':
      case 'throw':
      case 'exception':
        result.throws.push(inlineTags(text))
        break
      case 'since':
        result.since = text
        break
      case 'deprecated':
        result.deprecated = inlineTags(text)
        break
      case 'example':
        result.examples.push(text)
        break
      case 'see':
        result.see.push(inlineTags(text))
        break
      default:
        result.other.push({ tag, text: inlineTags(text) })
    }
  }
  return result
}
