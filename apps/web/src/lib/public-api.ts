import type { ApiSymbol, ApiSymbolKind, PublicApiVersion } from '@holtkeeper/api'

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
    ? `${version.version} · ${ref}`
    : version.version
}

/** Value of a version in pickers and links: `head` for the default branch, else the version. */
export const versionKey = (version: PublicApiVersion) => (version.head ? 'head' : version.version)

/** Share of exports with a doc comment, rounded; `undefined` without exports. */
export const documentedShare = (documented: number, exports: number) =>
  exports ? Math.round((documented / exports) * 100) : undefined

/** Ways to add the MCP endpoint to clients; `secret` defaults to a placeholder. */
export function mcpSetup(endpoint: string, secret = '<token>') {
  const header = `Authorization: Bearer ${secret}`
  return {
    claudeCode: `claude mcp add --transport http holtkeeper ${endpoint} --header "${header}"`,
    json: JSON.stringify(
      {
        mcpServers: {
          holtkeeper: {
            type: 'http',
            url: endpoint,
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      },
      null,
      2,
    ),
  }
}

/** Expiry choices of a new token, in days; `0` never expires. */
export const tokenLifetimes = [
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: '365', label: '1 year' },
  { id: '0', label: 'Never' },
] as const
