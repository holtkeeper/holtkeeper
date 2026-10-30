import type { CodeChange } from '@holtkeeper/changes'

/** One translation unit as read from a catalog file. */
export interface CatalogEntry {
  /** Full key: nested JSON/YAML keys joined with `.`, gettext `msgctxt` joined as `ctx\u0004id`. */
  key: string
  /** Translated text; `''` when empty. Plural gettext entries hold their first form here. */
  value: string
  /** Source text when the format carries it next to the translation (gettext `msgid`). */
  source?: string
  /** Plural source text (gettext `msgid_plural`). */
  plural?: string
  /** Every plural form, for formats that store them by index (gettext `msgstr[n]`). */
  forms?: string[]
  /** Marked as needing review by the translator (gettext `#, fuzzy`). */
  fuzzy?: boolean
  /** 1-based line where the entry starts. */
  line: number
}

/** What a `CatalogSource` reads from one file. */
export interface ParsedCatalog {
  /** Entries in file order. */
  entries: CatalogEntry[]
  /** Plural forms the file declares (gettext `Plural-Forms: nplurals=N`). */
  pluralForms?: number
  /** Locale the file declares about itself (gettext `Language:` header). */
  locale?: string
}

/** Where a catalog file belongs: its locale and the bundle of files that translate each other. */
export interface CatalogLocation {
  locale: string
  /** i18next namespace or gettext domain, when the layout has one. */
  namespace?: string
  /** The path with the locale replaced by `{locale}`; files of one bundle share the same keys. */
  bundle: string
}

/** A key a change adds to a catalog. */
export interface CatalogInsert {
  key: string
  value: string
  /** Plural forms for formats that store them by index. */
  forms?: string[]
  /** The base-locale entry the key is copied from, for formats that repeat source text. */
  base?: CatalogEntry
}

/**
 * One catalog format (i18next JSON, YAML, gettext, ...). Sources are independent: detection asks
 * each one whether it reads a file, and editing goes back to the source that parsed it.
 */
export interface CatalogSource {
  format: string
  /** Whether `file` (repository-relative, `/` separators) may be a catalog of this format. */
  matches(file: string): boolean
  /** Locale and bundle of `file` when the format has its own layout rules; generic rules otherwise. */
  locate?(file: string): CatalogLocation | undefined
  /** Throws on files that are not valid catalogs of this format. */
  parse(text: string, file: string): ParsedCatalog
  /**
   * `text` with `inserts` added, keeping indentation and placing each key next to its nearest
   * sibling in `order` (the key order the file should follow). Absent when the format is read-only.
   */
  insert?(text: string, inserts: readonly CatalogInsert[], order: readonly string[]): string
  /** `text` without `keys`; absent when the format is read-only. */
  remove?(text: string, keys: readonly string[]): string
}

/** A 1-based place in a source file. */
export interface SourceLocation {
  file: string
  line: number
  column: number
}

/** A translation call with a static key. */
export interface KeyUsage extends SourceLocation {
  key: string
  /** Namespace given explicitly (`t('ns:key')`, `t('key', { ns })`). */
  namespace?: string
}

/** A translation call whose key is computed at run time. */
export interface DynamicUsage extends SourceLocation {
  /** The call's key expression as written. */
  text: string
  /** Static start of the key (`` t(`errors.${code}`) `` → `errors.`); keys under it count as used. */
  prefix?: string
}

/**
 * A catalog bundle: the files of every locale (and layer) that translate the same keys. With
 * layers, a bundle is one namespace merged across layers.
 */
export interface BundleInfo {
  /** Path template with `{locale}` for auto-detected catalogs, the namespace with layers. */
  id: string
  namespace?: string
  formats: string[]
  files: { locale: string; layer: string; file: string }[]
}

export interface LocaleStats {
  locale: string
  base: boolean
  /** Listed as optional: reported, but not counted in the average and not filled by changes. */
  optional?: boolean
  /** Base keys this locale translates (present, not empty, not a copy of the base text). */
  translated: number
  missing: number
  /** Keys only this locale has. */
  extra: number
  untranslated: number
  /** `translated / base keys × 100`, one decimal. */
  completeness: number
}

/** A base key that one locale lacks. */
export interface MissingKey {
  bundle: string
  key: string
  locale: string
  /** File the key belongs in; absent when the locale has no file in this bundle. */
  file?: string
  /** Layer the key should be written to, by the write rules. */
  layer?: string
}

/** A key that only non-base locales have. */
export interface ExtraKey {
  bundle: string
  key: string
  locale: string
  file: string
}

export interface UntranslatedKey {
  bundle: string
  key: string
  locale: string
  file: string
  reason: 'empty' | 'identical' | 'fuzzy'
}

export interface PlaceholderIssue {
  bundle: string
  key: string
  locale: string
  file: string
  /** Placeholders of the base text the translation lacks. */
  missing: string[]
  /** Placeholders the translation has and the base text does not. */
  unexpected: string[]
}

export interface PluralIssue {
  bundle: string
  key: string
  locale: string
  file: string
  /** CLDR categories (`few`, `many`) or gettext form indexes (`[2]`) the translation lacks. */
  missing: string[]
}

export interface UnusedKey {
  bundle: string
  key: string
  layer: string
  /** Defined in a shared layer: other projects may use it, so it is informational. */
  shared: boolean
}

export interface UsageData {
  /** Source files scanned. */
  files: number
  /** Static translation calls found. */
  references: number
  /** Static keys used in code that no base catalog has. */
  missingInBase: KeyUsage[]
  /** Base keys no static call, dynamic prefix or ignore pattern covers. */
  unused: UnusedKey[]
  dynamic: DynamicUsage[]
}

/** Repository a change belongs to when it is not the analyzed one. */
export type ChangeTarget = NonNullable<CodeChange['target']>

/** A catalog layer as analyzed: where its files came from. */
export interface LayerInfo {
  id: string
  /** Repository of the layer; absent for the analyzed repository. */
  repo?: ChangeTarget
  ref?: string
  /** `files` template of the layer, absent for auto-detected catalogs. */
  files?: string
  /**
   * Lives in another repository and is shared with other projects (e.g. common translations):
   * an external layer whose `files` do not use `{repo}` or `{repoName}`.
   */
  shared: boolean
  /** Catalog files found. */
  catalogs: number
}

/** Which layers define a base key; the last one wins. */
export interface KeyProvenance {
  bundle: string
  key: string
  /** Layer whose value is used. */
  layer: string
  /** Every layer defining the key, in merge order. */
  layers: string[]
}

/** A key a later layer redefines, e.g. a game overriding a common translation. */
export interface KeyOverride {
  bundle: string
  key: string
  locale: string
  layer: string
  /** Earlier layers whose value is replaced. */
  overrides: string[]
}

/** Serializable result of the `i18n` analysis. */
export interface I18nData {
  baseLocale: string
  /** Whether suggested changes were produced (`suggest`) or only the report (`report`). */
  mode: 'report' | 'suggest'
  /** Catalog layers in merge order; one `local` layer when catalogs were auto-detected. */
  layers: LayerInfo[]
  /** Base-locale keys defined by more than one layer, or by any layer when there are several. */
  provenance: KeyProvenance[]
  overrides: KeyOverride[]
  /** Catalog formats found, e.g. `json`, `po`. */
  formats: string[]
  bundles: BundleInfo[]
  /** Every locale, base first. */
  locales: LocaleStats[]
  /** Keys of the base locale; plural variants count once. */
  keys: number
  missing: MissingKey[]
  extra: ExtraKey[]
  untranslated: UntranslatedKey[]
  placeholders: PlaceholderIssue[]
  plurals: PluralIssue[]
  usage: UsageData
  /** Suggested catalog edits, all `review`. */
  changes: CodeChange[]
}
