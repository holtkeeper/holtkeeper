import { z } from 'zod'

/**
 * How code uses an export: `call`ed, constructed with `new`, rendered as a `jsx` element, read
 * through a `member`, named as a `type`, a class `extends` it, `reexport`ed, passed around as a
 * plain `reference`, or only `import`ed (side-effect imports and unused bindings).
 */
export type UsageKind =
  | 'call'
  | 'new'
  | 'jsx'
  | 'member'
  | 'type'
  | 'extends'
  | 'reexport'
  | 'reference'
  | 'import'

export const usageKinds = [
  'call',
  'new',
  'jsx',
  'member',
  'type',
  'extends',
  'reexport',
  'reference',
  'import',
] as const satisfies readonly UsageKind[]

/** Whether `value` names a `UsageKind`, e.g. a query parameter. */
export const isUsageKind = (value: string): value is UsageKind =>
  usageKinds.some((kind) => kind === value)

/** One place in the code that uses an export of a package. */
export interface UsageSite {
  /** Relative to the checkout, `/`-separated. */
  file: string
  /** 1-based line and column of the used name. */
  line: number
  column: number
  kind: UsageKind
  /**
   * What is read from the export, `.`-separated; `()` stands for a call result, so
   * `useStore().reset` reads `reset` of what `useStore()` returns.
   */
  member?: string
  /** JSX attributes passed to a component, in source order; `children` when it has any. */
  props?: string[]
  /** A JSX `{...spread}` passed props this list cannot name. */
  spread?: boolean
  /** Found by the type checker rather than by following imports, e.g. a method of a hook's result. */
  typed?: boolean
  /** A few source lines around the site; the first is line `snippetLine`. */
  snippet: string
  snippetLine: number
}

/** How often one name occurs across the sites of an export. */
export interface NameCount {
  name: string
  count: number
}

/** One export of a package as the repository uses it. */
export interface UsedExport {
  /** Exported name; `default` for the default export, `*` for the module as a whole. */
  name: string
  /** Entry point imported from, `.` for the package itself, `./button` for `pkg/button`. */
  subpath: string
  /** Total sites, including those left out of `sites`. */
  count: number
  /** Files with at least one site. */
  files: number
  kinds: Partial<Record<UsageKind, number>>
  /** Members read from it, most used first. */
  members: NameCount[]
  /** JSX props passed to it, most used first. */
  props: NameCount[]
  /** Sites that spread props into it. */
  spread: number
  /** Sites in file order, capped; `truncated` counts the rest. */
  sites: UsageSite[]
  truncated?: number
}

/** A package the repository's code imports and what it uses of it. */
export interface UsedPackage {
  name: string
  /** Versions the lockfile resolves for the importing workspaces, highest first; empty when unknown. */
  versions: string[]
  /** Ranges the importing workspaces declare in `package.json`. */
  ranges: string[]
  /** Workspaces whose code imports it, by package name (`root` for an unnamed root). */
  workspaces: string[]
  /** The repository defines the package itself, as one of its workspaces. */
  local?: boolean
  count: number
  files: number
  exports: UsedExport[]
}

/** Whether the type checker ran, and if not, why. */
export interface TypeResolution {
  status: 'used' | 'skipped' | 'failed'
  reason?: string
  /** Projects (`tsconfig.json`) it loaded, relative to the checkout. */
  projects?: string[]
  /** Sites it added beyond what imports show. */
  sites?: number
}

/** Everything a `usages` analysis found; serializable, stored as analysis data. */
export interface UsagesData {
  packages: UsedPackage[]
  /** Source files read. */
  files: number
  types: TypeResolution
  /** Files that could not be read or parsed, as `file: message`. */
  problems?: string[]
}

const countSchema = z.object({ name: z.string(), count: z.number() })

const siteSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  kind: z.enum(usageKinds),
  member: z.string().optional(),
  props: z.array(z.string()).optional(),
  spread: z.boolean().optional(),
  typed: z.boolean().optional(),
  snippet: z.string(),
  snippetLine: z.number(),
})

export const usagesDataSchema: z.ZodType<UsagesData> = z.object({
  packages: z.array(
    z.object({
      name: z.string(),
      versions: z.array(z.string()),
      ranges: z.array(z.string()),
      workspaces: z.array(z.string()),
      local: z.boolean().optional(),
      count: z.number(),
      files: z.number(),
      exports: z.array(
        z.object({
          name: z.string(),
          subpath: z.string(),
          count: z.number(),
          files: z.number(),
          kinds: z.partialRecord(z.enum(usageKinds), z.number()),
          members: z.array(countSchema),
          props: z.array(countSchema),
          spread: z.number(),
          sites: z.array(siteSchema),
          truncated: z.number().optional(),
        }),
      ),
    }),
  ),
  files: z.number(),
  types: z.object({
    status: z.enum(['used', 'skipped', 'failed']),
    reason: z.string().optional(),
    projects: z.array(z.string()).optional(),
    sites: z.number().optional(),
  }),
  problems: z.array(z.string()).optional(),
})

/** The import specifier of an entry point, e.g. `@acme/ui/button` for `./button`. */
export const importPath = (name: string, subpath: string) =>
  subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`
