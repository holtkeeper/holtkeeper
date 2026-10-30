import { z } from 'zod'

/** What an exported name is. `reexport` stands for `export * from '<another package>'`. */
export type ApiSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  | 'namespace'
  | 'reexport'

export const apiSymbolKinds = [
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'enum',
  'namespace',
  'reexport',
] as const satisfies readonly ApiSymbolKind[]

/** Whether `value` names an `ApiSymbolKind`, e.g. a query parameter. */
export const isApiSymbolKind = (value: string): value is ApiSymbolKind =>
  apiSymbolKinds.some((kind) => kind === value)

/** One exported name of an entry point. */
export interface ApiSymbol {
  /** Exported name; `default` for the default export, `*` for a star re-export of a package. */
  name: string
  kind: ApiSymbolKind
  /**
   * Declaration as a `.d.ts` would show it: function and method bodies, private class members and
   * long initializers left out; overloads one per line. Capped in length.
   */
  signature: string
  /** TSDoc / JSDoc text without comment markers, tags included. */
  doc?: string
  /** Text of `@deprecated`, or an empty string when the tag has none. */
  deprecated?: string
  /** Where it is declared, relative to the checkout, `/`-separated. */
  file: string
  line: number
}

/** One subpath of a package's `exports` (`.` for the main entry). */
export interface ApiEntry {
  subpath: string
  /** Source the symbols were read from, relative to the checkout; absent when none was found. */
  file?: string
  symbols: ApiSymbol[]
  /** Symbols left out by the cap; the count of `symbols` plus this is the real number. */
  truncated?: number
}

/** A package of the checkout and its public API. */
export interface ApiPackage {
  name: string
  version?: string
  description?: string
  private: boolean
  /** Folder of its `package.json`, relative to the checkout; `.` for the root. */
  dir: string
  entries: ApiEntry[]
  /** Files that could not be read or parsed, as `file: message`. */
  problems?: string[]
}

/** Everything an `api-surface` analysis found; serializable, stored as analysis data. */
export interface ApiSurfaceData {
  packages: ApiPackage[]
}

const symbolSchema = z.object({
  name: z.string(),
  kind: z.enum(apiSymbolKinds),
  signature: z.string(),
  doc: z.string().optional(),
  deprecated: z.string().optional(),
  file: z.string(),
  line: z.number(),
})

export const apiSurfaceDataSchema: z.ZodType<ApiSurfaceData> = z.object({
  packages: z.array(
    z.object({
      name: z.string(),
      version: z.string().optional(),
      description: z.string().optional(),
      private: z.boolean(),
      dir: z.string(),
      entries: z.array(
        z.object({
          subpath: z.string(),
          file: z.string().optional(),
          symbols: z.array(symbolSchema),
          truncated: z.number().optional(),
        }),
      ),
      problems: z.array(z.string()).optional(),
    }),
  ),
})

/** Counts over a package or a whole analysis. */
export function apiTotals(packages: readonly ApiPackage[]) {
  let symbols = 0
  let documented = 0
  let deprecated = 0
  for (const pkg of packages)
    for (const entry of pkg.entries)
      for (const symbol of entry.symbols) {
        if (symbol.kind === 'reexport') continue
        symbols += 1
        if (symbol.doc) documented += 1
        if (symbol.deprecated !== undefined) deprecated += 1
      }
  return { packages: packages.length, symbols, documented, deprecated }
}

/** Share of exported symbols with a doc comment, in percent; `undefined` without symbols. */
export const documentedPercent = ({
  symbols,
  documented,
}: {
  symbols: number
  documented: number
}) => (symbols ? (documented / symbols) * 100 : undefined)
