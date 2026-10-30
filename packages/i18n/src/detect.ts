import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { locateCatalog } from './locate.ts'
import { pluralSuffix } from './plurals.ts'
import { DEFAULT_LOCALE } from './sources/properties.ts'
import type { CatalogLocation, CatalogSource, ParsedCatalog } from './types.ts'

/** Directories never walked. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'vendor',
  'target',
  'coverage',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
])

const HINT_DIRECTORIES = new Set([
  'locales',
  'locale',
  '_locales',
  'i18n',
  'l10n',
  'lang',
  'langs',
  'languages',
  'translations',
  'translation',
  'messages',
  'intl',
])

const MAX_CATALOG_BYTES = 5 * 1024 * 1024

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name))
        files.push(...(await walk(dir, path)))
    } else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * Where catalog files come from: a checkout on disk today, a translation platform API (Crowdin,
 * Lokalise, Tolgee) later. Paths are relative to the store's root with `/` separators.
 */
export interface CatalogFiles {
  /** Every file, or those matching `glob`, in a stable order. */
  list(glob?: string): Promise<string[]>
  /** `undefined` when the file does not exist. */
  read(file: string): Promise<string | undefined>
}

/** Files of a local directory, skipping dot and `SKIPPED_DIRECTORIES` directories and huge files. */
export function diskCatalogFiles(root: string): CatalogFiles {
  let cached: Promise<string[]> | undefined
  return {
    async list(glob) {
      cached ??= walk(root)
      const files = await cached
      if (!glob) return files
      const matcher = new Bun.Glob(glob)
      return files.filter((file) => matcher.match(file))
    },
    async read(file) {
      const handle = Bun.file(join(root, file))
      if (!(await handle.exists()) || handle.size > MAX_CATALOG_BYTES) return undefined
      return handle.text()
    },
  }
}

/** One parsed catalog file. */
export interface CatalogFile {
  /** Path relative to the root of the repository (or store) the file came from. */
  file: string
  /** Id of the layer the file belongs to; `local` for auto-detected catalogs. */
  layer: string
  text: string
  source: CatalogSource
  location: CatalogLocation
  catalog: ParsedCatalog
}

export interface DetectedCatalogs {
  files: CatalogFile[]
  /** Files that looked like catalogs but did not parse. */
  errors: { file: string; message: string }[]
}

export interface DetectOptions {
  files: CatalogFiles
  sources: readonly CatalogSource[]
  /** Globs that select catalog files instead of the layout heuristics. */
  locales?: readonly string[]
}

const CONFIG_FILE =
  /(^|\/)((next-)?i18next(-parser)?\.config|i18n\.config|i18n|i18n\/index|lingui\.config|nuxt\.config|next\.config)\.[cm]?[jt]s$/
const CONFIG_KEYS = ['sourceLocale', 'defaultLocale', 'baseLocale', 'fallbackLng', 'fallbackLocale']

/** The base locale an i18n config file declares, by the usual option names. */
export function baseFromConfig(text: string): string | undefined {
  for (const key of CONFIG_KEYS) {
    const match = new RegExp(
      `\\b${key}\\s*:\\s*[[{]?\\s*(?:default\\s*:\\s*\\[?\\s*)?['"\`]([\\w-]+)['"\`]`,
    ).exec(text)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** Base locale named by the first i18n config file (`i18next.config.ts`, `i18n.ts`, ...) found. */
export async function configBaseLocale(files: CatalogFiles): Promise<string | undefined> {
  for (const file of await files.list()) {
    if (!CONFIG_FILE.test(file)) continue
    const text = await files.read(file)
    const base = text ? baseFromConfig(text) : undefined
    if (base) return base
  }
  return undefined
}

const hinted = (file: string) => file.split('/').some((part) => HINT_DIRECTORIES.has(part))

/**
 * Finds catalog files by format and layout and parses them. JSON and YAML files count as
 * catalogs only under a translation directory or when at least two locales of the same bundle
 * exist, so ordinary config files are not mistaken.
 */
export async function detectCatalogs({
  files,
  sources,
  locales,
}: DetectOptions): Promise<DetectedCatalogs> {
  const globs = locales?.map((pattern) => new Bun.Glob(pattern))
  const candidates: { file: string; source: CatalogSource; location: CatalogLocation }[] = []
  for (const file of await files.list()) {
    if (globs && !globs.some((glob) => glob.match(file))) continue
    const source = sources.find((s) => s.matches(file))
    if (!source) continue
    const location = source.locate ? source.locate(file) : locateCatalog(file)
    if (location) candidates.push({ file, source, location })
  }

  const perBundle = Map.groupBy(candidates, (c) => `${c.source.format}:${c.location.bundle}`)
  const result: DetectedCatalogs = { files: [], errors: [] }
  for (const group of perBundle.values()) {
    const structured = group[0]!.source.format === 'json' || group[0]!.source.format === 'yaml'
    if (!globs && structured && group.length < 2 && !hinted(group[0]!.file)) continue
    for (const { file, source, location } of group) {
      const text = await files.read(file)
      if (text === undefined) continue
      try {
        result.files.push({
          file,
          layer: 'local',
          text,
          source,
          location,
          catalog: source.parse(text, file),
        })
      } catch (error) {
        result.errors.push({
          file,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return result
}

/**
 * The base locale: the requested one, else the config's when catalogs have it, else the locale
 * with the most keys (plural variants counted once, keys only one locale has not counted; `en`
 * wins when within 5% of the most), else `en`.
 */
export function chooseBaseLocale(
  files: readonly CatalogFile[],
  requested?: string,
  configBase?: string,
): string {
  if (requested) return requested
  const keys = new Map<string, Set<string>>()
  for (const file of files) {
    if (file.location.locale === DEFAULT_LOCALE) continue
    const set = keys.get(file.location.locale) ?? new Set()
    for (const entry of file.catalog.entries)
      set.add(`${file.location.bundle}\0${pluralSuffix(entry.key)?.stem ?? entry.key}`)
    keys.set(file.location.locale, set)
  }
  if (configBase && keys.has(configBase)) return configBase
  const owners = new Map<string, number>()
  for (const set of keys.values())
    for (const key of set) owners.set(key, (owners.get(key) ?? 0) + 1)
  const shared = (set: Set<string>) =>
    keys.size < 2 ? set.size : [...set].filter((key) => (owners.get(key) ?? 0) > 1).length
  const ranked = [...keys]
    .map(([locale, set]) => [locale, shared(set)] as const)
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
  const most = ranked[0]?.[1] ?? 0
  const english = ranked.find(([locale]) => locale === 'en')
  if (english && english[1] >= most * 0.95) return 'en'
  return ranked[0]?.[0] ?? configBase ?? 'en'
}
