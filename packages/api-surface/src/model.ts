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

/** Package ecosystem an `ApiPackage` belongs to; absent on a package means `npm`. */
export type ApiEcosystem = 'npm' | 'Go'

/**
 * A package of the checkout and its public API. An npm package is one `package.json`; a Go
 * package is one package directory, named by its full import path with the single entry `.`.
 */
export interface ApiPackage {
  name: string
  version?: string
  description?: string
  /** npm: `private` in `package.json`. Go: the package sits under an `internal/` directory. */
  private: boolean
  /** Folder of its `package.json` (Go: of the package), relative to the checkout; `.` for the root. */
  dir: string
  /** Absent for npm packages. */
  ecosystem?: ApiEcosystem
  /** Go only: path of the module that owns the package, with its `/vN` suffix. */
  module?: string
  entries: ApiEntry[]
  /** Files that could not be read or parsed, as `file: message`. */
  problems?: string[]
}

/** A Go module of the checkout and how many of its packages are importable, internal or `main`. */
export interface ApiGoModule {
  /** Module path with its `/vN` suffix. */
  path: string
  /** Folder of its `go.mod`, relative to the checkout; `.` for the root. */
  dir: string
  version?: string
  /** Packages outside `internal/` that other modules can import. */
  packages: number
  internalPackages: number
  /** `package main` directories, never listed in `packages`. */
  mainPackages: number
}

/** Everything an `api-surface` analysis found; serializable, stored as analysis data. */
export interface ApiSurfaceData {
  packages: ApiPackage[]
  /** Go modules found in the checkout; absent when there are none or the analysis predates Go. */
  go?: { modules: ApiGoModule[] }
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
      ecosystem: z.enum(['npm', 'Go']).optional(),
      module: z.string().optional(),
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
  go: z
    .object({
      modules: z.array(
        z.object({
          path: z.string(),
          dir: z.string(),
          version: z.string().optional(),
          packages: z.number(),
          internalPackages: z.number(),
          mainPackages: z.number(),
        }),
      ),
    })
    .optional(),
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
