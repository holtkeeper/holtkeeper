# @holtkeeper/i18n

Translation gaps of a repository: keys missing per locale, keys only some locales have, empty or untranslated values, placeholder and plural mismatches, keys used in code but missing from the base locale, and keys nothing uses. Produces serializable `I18nData`, an `i18n` analysis kind that renders it as a universal `Report`, and the `i18nAnalyzer`.

## Pipeline

1. **Catalog files** come through `CatalogFiles { list(glob?), read(file) }`. `diskCatalogFiles(dir)` reads a checkout (skipping dot directories, `node_modules`, `dist`, ...). A translation platform API (Crowdin, Lokalise, Tolgee) can implement the same contract.
2. **`CatalogSource`** — one module per format, each `matches(file)`, `locate?(file)`, `parse(text)`, and optionally `insert(text, inserts, order)` / `remove(text, keys)`:
   - `jsonSource()` — i18next / react-i18next / vue-i18n / formatjs: nested or flat keys, `{ id: { defaultMessage } }`, Chrome `{ message }`, compiled formatjs ASTs. Edits keep indentation, `": "` spacing, CRLF and key order.
   - `yamlSource()` — `Bun.YAML`, Rails `ru:` roots unwrapped. Read-only.
   - `poSource()` — gettext `msgctxt` (key `ctx\u0004id`), `msgid_plural`/`msgstr[n]`, `#, fuzzy`, `Plural-Forms`. Added entries are marked `#, fuzzy`.
   - `propertiesSource()` — Java/Kotlin bundles; `messages.properties` is the default (`und`) locale, mapped to the base locale.
3. **Discovery** — without layers, `detectCatalogs` finds catalogs by layout (`locales/<lng>/<ns>.json`, `<lng>.json`, `public/locales/...`, `<lng>/LC_MESSAGES/<domain>.po`, `messages_<lng>.properties`); JSON/YAML count only under a translation directory or with at least two locales. `configBaseLocale` reads `sourceLocale` / `defaultLocale` / `fallbackLng` from `i18next.config`, `next-i18next.config`, `i18n.ts`, `lingui.config`, `next.config`, `nuxt.config`. `chooseBaseLocale` then picks: option → config → the locale with the most shared keys (`en` wins within 5%) → `en`.
4. **Layers** (optional) — catalogs merged in order from several places, later layers overriding earlier ones per key; see below.
5. **Usage** — `scanSource` runs ast-grep over JS/TS/TSX (regex for Vue/Svelte/Astro/HTML) for the `functions` patterns: `t`, `i18n.t`, `$t`, `this.$t`, `useTranslation().t`, `<Trans i18nKey>`, `<FormattedMessage id>`, `formatMessage({ id })`, `intl.formatMessage`. Static keys (with `ns:key` and `{ ns }`) are matched against base keys (a key that prefixes nested keys uses them all); computed keys are dynamic usages, and their static prefix (`` `errors.${code}` `` → `errors.`) keeps keys under it from being reported unused.
6. **`analyzeCatalogs`** — pure. Compares every locale with the base: missing, extra, empty / fuzzy / identical-to-base (`looksTranslatable` skips short tokens, acronyms, brand-like words, URLs), placeholders (`{{name}}`, ICU `{name}` and `{n, plural, ...}`, `%s`/`%1$s`, `<0>`/`<b>` tags), plural forms by CLDR category (embedded table for en, ru, uk, pl, de, fr, es, it, pt, tr, ja, zh, ko, ar, he, cs; `Intl.PluralRules` otherwise) for i18next `_one/_few/...` keys and ICU plurals, and gettext form counts. In `suggest` mode it also produces changes.
7. **`analyzeI18n`** wires everything; **`i18nAnalyzer`** is the `Analyzer` (`kind: 'i18n'`, `scope: 'repo'`, `needs: { checkout: true }`).

## Options

```ts
{
  mode: 'report' | 'suggest',          // default report: no changes
  locales?: { base?, required?, optional?, ignore? },
  baseLocale?: string,                  // flat alias of locales.base (--base-locale)
  layers?: [{ id, repo?: 'forge:path', ref?, files, format?: 'json'|'yaml'|'po'|'properties'|'auto', namespace? }],
  write?: [{ keys?: globs, namespaces?: string[], layer }],
  functions?: string[], ignoreKeys?: string[],
  fill: 'todo' | 'base' | 'empty',      // default todo
  marker: string,                       // default 'TODO: '
  __checkouts?: { 'forge:path': '/abs/dir' },
}
```

Required locales are expected even without files (all keys missing). Optional locales are reported but left out of the average completeness and get no changes. Ignored locales are skipped.

## Layers

Translations often live in a shared repository: common translations plus a folder per project, combined with files of the project itself:

```ts
layers: [
  { id: 'common', repo: 'work:i18n/translations', ref: 'main', files: 'common/{locale}/{namespace}.json' },
  { id: 'game', repo: 'work:i18n/translations', files: 'games/{repoName}/{locale}/{namespace}.json' },
  { id: 'local', files: 'src/locales/{locale}.json', namespace: 'game' },
],
write: [{ namespaces: ['ui'], layer: 'common' }, { keys: 'local.*', layer: 'local' }, { layer: 'game' }],
```

- `files` templates (`compileTemplate`, pure): `{locale}`, `{namespace}`, `{repo}` (analyzed repository path), `{repoName}` (its last segment), `{group}` (path without it), `*`, `**`. Without `{locale}` the locale comes from the path layout; without `{namespace}` the layer's `namespace` (or `default`) applies. Layers merge per namespace.
- A layer without `repo` (or with the analyzed repository) reads the analyzed checkout. Other repositories must be checked out by the runner: `requiredCheckouts(options, repo)` lists `{ repo, ref? }` once per repository, and the runner passes their directories as `options.__checkouts` (`--checkout forge:path=/abs/dir`, comma-separated for several). A missing checkout is an error. Source code is always scanned in the analyzed checkout.
- An external layer whose template does not use `{repo}`/`{repoName}` is **shared**: its unused keys are informational (other projects use them) and never removed.
- `write` rules route missing keys; the first rule whose criteria all match wins; default is the last layer having files of the namespace. Missing locale files are created when the template has no globs.

## Changes

`suggest` mode only, all `confidence: 'review'`, `source: 'i18n'`:

- `i18n:missing:[forge:path:]<file>` — one per catalog file: missing keys (and missing i18next plural variants) copied from the base with `fill`, placed next to the nearest sibling in base order, as one whole-file `replace` (exact `oldText`) or a `create` for a new file.
- `i18n:unused:[forge:path:]<bundle>` — unused, non-shared keys removed from every locale file of the bundle (empty parent objects too).

Changes to an external layer carry `target: { forge, path }` of the layer's repository and repository-relative paths, so accepting opens the merge request there. Both kinds rewrite whole files: accept one and re-run before accepting the other for the same file.

## Data

`I18nData`: `baseLocale`, `mode`, `layers` (`LayerInfo`), `provenance` (base keys: effective layer and every layer defining it), `overrides` (keys a later layer redefines, per locale), `formats`, `bundles`, `locales` (`LocaleStats` with completeness %), `keys`, `missing` (with write layer and file), `extra`, `untranslated`, `placeholders`, `plurals`, `usage` (`files`, `references`, `missingInBase` with locations, `unused` with layer and `shared`, `dynamic`), `changes`. `i18nDataSchema` validates uploads.

## Report

Metrics: locales, keys, average completeness, missing, untranslated, unused (own; shared ones in the hint), placeholder errors, plural gaps, used-but-not-in-base; all with deltas against the previous record.

Sections: **Completeness** (bar chart and table per locale with change, catalogs table, a note when layers live elsewhere), **Layers** (merge order, overrides of shared keys as info issues, key provenance; only with several layers), **Missing keys** (key × locale table with write layer and `new` marks, missing per layer and locale, untranslated values, keys only in non-base locales), **Placeholders and plurals** (issues), **Usage** (missing-in-base issues with locations, unused keys, shared keys this project does not use, dynamic usages), **Suggested changes** (`changes` block, applicable).

## Limitations

- YAML catalogs are read-only (no changes); JSON with comments (JSONC/JSON5) is not parsed.
- Untranslated detection by identity is heuristic; use `ignoreKeys` for brand names it misses.
- Usage matching is lenient about namespaces when calls do not name one (`useTranslation('ns')` defaults are not tracked); i18next context suffixes are not modeled.
- Checkouts are keyed by repository, not by ref.
