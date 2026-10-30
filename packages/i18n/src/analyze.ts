import type { CodeChange, Edit } from '@holtkeeper/changes'

import type { CatalogFile } from './detect.ts'
import type { FileTemplate } from './layers.ts'
import { comparePlaceholders, messageShape, stripPlaceholders } from './placeholders.ts'
import {
  gettextForms,
  PLURAL_CATEGORIES,
  type PluralCategory,
  pluralCategories,
  pluralKey,
  pluralSuffix,
  sameLanguage,
} from './plurals.ts'
import { DEFAULT_LOCALE } from './sources/properties.ts'
import type {
  BundleInfo,
  CatalogEntry,
  CatalogInsert,
  CatalogSource,
  ChangeTarget,
  DynamicUsage,
  ExtraKey,
  I18nData,
  KeyOverride,
  KeyProvenance,
  KeyUsage,
  LayerInfo,
  LocaleStats,
  MissingKey,
  PlaceholderIssue,
  PluralIssue,
  UnusedKey,
  UntranslatedKey,
} from './types.ts'

/** How added keys are filled: the base text, nothing, or the base text after a marker. */
export type FillMode = 'base' | 'empty' | 'todo'

/** A layer as the analysis sees it: merge position is its index in `layers`. */
export interface AnalysisLayer {
  info: LayerInfo
  /** Repository changes to this layer's files belong to; absent for the analyzed one. */
  target?: ChangeTarget
  /** Renders paths of catalog files the layer does not have yet. */
  template?: FileTemplate
}

/** Where missing keys are written; the first rule whose criteria all match wins. */
export interface WriteRule {
  /** Globs matched against `key` and `namespace:key`. */
  keys?: readonly string[]
  namespaces?: readonly string[]
  layer: string
}

/** Which locales matter: required ones are expected even without files, ignored ones skipped. */
export interface LocalePolicy {
  required?: readonly string[]
  optional?: readonly string[]
  ignore?: readonly string[]
}

export interface AnalyzeCatalogsOptions {
  /** Catalog files of every layer; `file.layer` names the layer. */
  files: readonly CatalogFile[]
  baseLocale: string
  /** Layers in merge order; later ones override earlier ones. Default: one `local` layer. */
  layers?: readonly AnalysisLayer[]
  write?: readonly WriteRule[]
  locales?: LocalePolicy
  /** `suggest` also produces changes; default `report`. */
  mode?: 'report' | 'suggest'
  usage?: { files: number; keys: readonly KeyUsage[]; dynamic: readonly DynamicUsage[] }
  /** Globs of keys left out of every check, matched against `key` and `namespace:key`. */
  ignoreKeys?: readonly string[]
  fill?: FillMode
  /** Prefix of filled values in `todo` mode; default `TODO: `. */
  marker?: string
}

interface Provided {
  entry: CatalogEntry
  file: CatalogFile
  /** Layers defining the key, in merge order. */
  layers: string[]
}

/** One translatable unit of the base locale: a key, or an i18next plural group by its stem. */
interface LogicalKey {
  key: string
  entry: CatalogEntry
  provided: Provided
  plural?: { ordinal: boolean; variants: Map<PluralCategory, CatalogEntry> }
}

interface Bundle {
  info: BundleInfo
  /** Locale → files in layer order. */
  files: Map<string, CatalogFile[]>
  /** Locale → key → merged entry. */
  merged: Map<string, Map<string, Provided>>
}

/**
 * Whether an untranslated-looking copy of the base text is likely a real gap: short tokens,
 * acronyms, brand-like words (`GitHub`), URLs and placeholder-only messages are expected to match.
 */
export function looksTranslatable(text: string): boolean {
  const stripped = stripPlaceholders(text).trim()
  if (/^(https?:\/\/|www\.)\S+$|^\S+@\S+\.\S+$/.test(stripped)) return false
  const words = stripped.match(/\p{L}+/gu) ?? []
  if (words.length === 0) return false
  if (words.length === 1) {
    const word = words[0] ?? ''
    if (word.length <= 4) return false
    if (word === word.toUpperCase()) return false
    if (/\p{Ll}\p{Lu}/u.test(word)) return false
  }
  return true
}

const textOf = (entry: CatalogEntry) => entry.value || entry.source || ''

function logicalKeys(merged: Map<string, Provided>): LogicalKey[] {
  const result: LogicalKey[] = []
  const groups = new Map<string, LogicalKey>()
  for (const [key, provided] of merged) {
    const suffix = pluralSuffix(key)
    if (suffix && merged.has(pluralKey(suffix.stem, 'other'))) {
      let group = groups.get(suffix.stem)
      if (!group) {
        group = {
          key: suffix.stem,
          entry: provided.entry,
          provided,
          plural: { ordinal: suffix.ordinal, variants: new Map() },
        }
        groups.set(suffix.stem, group)
        result.push(group)
      }
      group.plural!.variants.set(suffix.category, provided.entry)
      if (suffix.category === 'other') {
        group.entry = provided.entry
        group.provided = provided
      }
      continue
    }
    result.push({ key, entry: provided.entry, provided })
  }
  return result
}

const requiredCategories = (locale: string, ordinal: boolean) => {
  const required = new Set<PluralCategory>(
    pluralCategories(locale, ordinal ? 'ordinal' : 'cardinal'),
  )
  required.add('other')
  return PLURAL_CATEGORIES.filter((category) => required.has(category))
}

function groupBundles(
  files: readonly CatalogFile[],
  baseLocale: string,
  layerOrder: readonly string[],
): Bundle[] {
  const rank = (layer: string) => {
    const index = layerOrder.indexOf(layer)
    return index === -1 ? layerOrder.length : index
  }
  const byId = Map.groupBy(files, (file) => file.location.bundle)
  const bundles: Bundle[] = []
  for (const [id, group] of byId) {
    const sorted = group.toSorted(
      (a, b) => rank(a.layer) - rank(b.layer) || a.file.localeCompare(b.file),
    )
    const hasBase = sorted.some((file) => file.location.locale === baseLocale)
    const perLocale = new Map<string, CatalogFile[]>()
    for (const file of sorted) {
      const locale =
        file.location.locale === DEFAULT_LOCALE && !hasBase ? baseLocale : file.location.locale
      const list = perLocale.get(locale) ?? []
      if (!list.some((other) => other.layer === file.layer)) list.push(file)
      perLocale.set(locale, list)
    }
    const merged = new Map<string, Map<string, Provided>>()
    for (const [locale, list] of perLocale) {
      const entries = new Map<string, Provided>()
      for (const file of list) {
        for (const entry of file.catalog.entries) {
          const before = entries.get(entry.key)
          entries.set(entry.key, { entry, file, layers: [...(before?.layers ?? []), file.layer] })
        }
      }
      merged.set(locale, entries)
    }
    const namespace = sorted.find((file) => file.location.namespace)?.location.namespace
    bundles.push({
      info: {
        id,
        ...(namespace ? { namespace } : {}),
        formats: [...new Set(sorted.map((file) => file.source.format))].toSorted(),
        files: [...perLocale].flatMap(([locale, list]) =>
          list.map((file) => ({ locale, layer: file.layer, file: file.file })),
        ),
      },
      files: perLocale,
      merged,
    })
  }
  return bundles.toSorted((a, b) => a.info.id.localeCompare(b.info.id))
}

function fillValue(text: string, mode: FillMode, marker: string) {
  if (mode === 'empty') return ''
  if (mode === 'base') return text
  return `${marker}${text}`
}

/** A whole-file `replace` edit, so `oldText` pins the exact contents the change was made for. */
export function wholeFileEdit(file: string, oldText: string, newText: string): Edit {
  const lines = oldText.split('\n')
  return {
    kind: 'replace',
    file,
    range: {
      start: { line: 1, column: 1 },
      end: { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 },
    },
    oldText,
    newText,
  }
}

const listed = (keys: readonly string[], limit = 20) =>
  keys
    .slice(0, limit)
    .map((key) => `- \`${key}\``)
    .concat(keys.length > limit ? [`- … and ${keys.length - limit} more`] : [])
    .join('\n')

const EMPTY_CATALOG: Record<string, string> = { json: '{}\n' }

const globs = (patterns: readonly string[] | undefined) =>
  (patterns ?? []).map((pattern) => new Bun.Glob(pattern))

const matchesKey = (patterns: readonly Bun.Glob[], key: string, namespace?: string) =>
  patterns.some(
    (glob) => glob.match(key) || (namespace ? glob.match(`${namespace}:${key}`) : false),
  )

interface PendingFile {
  path: string
  layer: string
  file?: CatalogFile
  source: CatalogSource
  inserts: CatalogInsert[]
  keys: string[]
  order: string[]
}

/**
 * Merges layers, compares every locale with the base one and code usage with the catalogs.
 * Pure: catalogs and usages come in, serializable `I18nData` (with suggested edits in `suggest`
 * mode) comes out.
 */
export function analyzeCatalogs(options: AnalyzeCatalogsOptions): I18nData {
  const { baseLocale, fill = 'todo', marker = 'TODO: ', mode = 'report' } = options
  const layers: readonly AnalysisLayer[] = options.layers?.length
    ? options.layers
    : [{ info: { id: 'local', shared: false, catalogs: options.files.length } }]
  const auto = !options.layers?.length
  const layerById = new Map(layers.map((layer) => [layer.info.id, layer]))
  const layerOrder = layers.map((layer) => layer.info.id)
  const ignore = globs(options.ignoreKeys)
  const isIgnored = (key: string, namespace?: string) => matchesKey(ignore, key, namespace)
  const rules = (options.write ?? []).map((rule) => ({
    ...rule,
    globs: rule.keys ? globs(rule.keys) : undefined,
  }))

  const policy = options.locales ?? {}
  const ignoredLocales = new Set(policy.ignore ?? [])
  const optionalLocales = new Set(policy.optional ?? [])
  const bundles = groupBundles(
    options.files.filter((file) => !ignoredLocales.has(file.location.locale)),
    baseLocale,
    layerOrder,
  )
  const localeSet = new Set([
    ...bundles.flatMap((bundle) => [...bundle.files.keys()]),
    ...(policy.required ?? []),
  ])
  localeSet.add(baseLocale)
  for (const locale of ignoredLocales) if (locale !== baseLocale) localeSet.delete(locale)
  const locales = [baseLocale, ...[...localeSet].filter((l) => l !== baseLocale).toSorted()]

  const stats = new Map<string, LocaleStats>(
    locales.map((locale) => [
      locale,
      {
        locale,
        base: locale === baseLocale,
        ...(optionalLocales.has(locale) && locale !== baseLocale ? { optional: true } : {}),
        translated: 0,
        missing: 0,
        extra: 0,
        untranslated: 0,
        completeness: 0,
      },
    ]),
  )
  const missing: MissingKey[] = []
  const extra: ExtraKey[] = []
  const untranslated: UntranslatedKey[] = []
  const placeholders: PlaceholderIssue[] = []
  const plurals: PluralIssue[] = []
  const provenance: KeyProvenance[] = []
  const overrides: KeyOverride[] = []
  const changes: CodeChange[] = []
  const baseKeys = new Map<Bundle, LogicalKey[]>()
  let total = 0

  for (const bundle of bundles) {
    const { id, namespace } = bundle.info
    const nsName = namespace ?? 'default'
    const baseMerged = bundle.merged.get(baseLocale)

    if (layers.length > 1) {
      for (const [locale, entries] of bundle.merged) {
        for (const [key, provided] of entries) {
          if (provided.layers.length > 1 && !isIgnored(key, namespace))
            overrides.push({
              bundle: id,
              key,
              locale,
              layer: provided.file.layer,
              overrides: provided.layers.slice(0, -1),
            })
        }
      }
    }

    if (!baseMerged) {
      for (const [locale, entries] of bundle.merged) {
        for (const [key, provided] of entries) {
          if (isIgnored(key, namespace) || !stats.has(locale)) continue
          extra.push({ bundle: id, key, locale, file: provided.file.file })
          stats.get(locale)!.extra++
        }
      }
      continue
    }
    const keys = logicalKeys(baseMerged).filter((k) => !isIgnored(k.key, namespace))
    baseKeys.set(bundle, keys)
    total += keys.length
    if (layers.length > 1) {
      for (const k of keys)
        provenance.push({
          bundle: id,
          key: k.key,
          layer: k.provided.file.layer,
          layers: k.provided.layers,
        })
    }
    const baseStems = new Set(keys.filter((k) => k.plural).map((k) => k.key))
    const layersInBundle = new Set([...bundle.files.values()].flat().map((file) => file.layer))
    const defaultLayer =
      layerOrder.findLast((layer) => layersInBundle.has(layer)) ?? layerOrder.at(-1)!

    const writeLayer = (key: string) => {
      for (const rule of rules) {
        if (rule.globs && !matchesKey(rule.globs, key, nsName)) continue
        if (rule.namespaces && !rule.namespaces.includes(nsName)) continue
        return rule.layer
      }
      return defaultLayer
    }

    for (const locale of locales) {
      const stat = stats.get(locale)!
      if (locale === baseLocale) {
        stat.translated += keys.length
        continue
      }
      const entries = bundle.merged.get(locale) ?? new Map<string, Provided>()
      const localeFiles = bundle.files.get(locale) ?? []
      const pending = new Map<string, PendingFile>()
      const order = desiredOrder(keys, locale)

      const queue = (key: string, insert: CatalogInsert) => {
        const layer = writeLayer(key)
        const existing = localeFiles.find((file) => file.layer === layer)
        const sample =
          existing ??
          [...bundle.files.values()].flat().find((file) => file.layer === layer) ??
          bundle.files.get(baseLocale)?.[0]
        const path =
          existing?.file ??
          layerById.get(layer)?.template?.render({ locale, ...(namespace ? { namespace } : {}) }) ??
          (auto && id.includes('{locale}') ? id.replace('{locale}', locale) : undefined)
        if (path && sample) {
          const item = pending.get(path) ?? {
            path,
            layer,
            ...(existing ? { file: existing } : {}),
            source: sample.source,
            inserts: [],
            keys: [],
            order,
          }
          item.inserts.push(insert)
          item.keys.push(key)
          pending.set(path, item)
        }
        return { layer, ...(path ? { file: path } : {}) }
      }

      const placeholderCheck = (
        key: string,
        base: CatalogEntry,
        provided: Provided,
        plural: boolean,
      ) => {
        const entry = provided.entry
        if (!entry.value) return
        const baseShape = messageShape(textOf(base))
        const shape = messageShape(entry.value)
        const diff = comparePlaceholders(baseShape.tokens, shape.tokens)
        if (plural)
          diff.missing = diff.missing.filter(
            (token) => token !== '{{count}}' && token !== '{count}',
          )
        if (diff.missing.length || diff.unexpected.length)
          placeholders.push({ bundle: id, key, locale, file: provided.file.file, ...diff })
        if (baseShape.plurals.length) {
          const lacking = new Set<string>()
          for (const icu of shape.plurals) {
            const have = new Set(icu.selectors)
            for (const category of requiredCategories(locale, icu.kind === 'selectordinal'))
              if (!have.has(category)) lacking.add(category)
          }
          if (lacking.size)
            plurals.push({
              bundle: id,
              key,
              locale,
              file: provided.file.file,
              missing: [...lacking],
            })
        }
      }

      const judge = (key: string, base: CatalogEntry, provided: Provided) => {
        const entry = provided.entry
        const forms = entry.forms ?? [entry.value]
        const reason: UntranslatedKey['reason'] | undefined = entry.fuzzy
          ? 'fuzzy'
          : forms.every((form) => form.trim() === '')
            ? 'empty'
            : !sameLanguage(locale, baseLocale) &&
                entry.value === textOf(base) &&
                looksTranslatable(entry.value)
              ? 'identical'
              : undefined
        if (reason) {
          untranslated.push({ bundle: id, key, locale, file: provided.file.file, reason })
          stat.untranslated++
          return false
        }
        stat.translated++
        return true
      }

      for (const logical of keys) {
        if (!logical.plural) {
          const provided = entries.get(logical.key)
          if (!provided) {
            const text = fillValue(textOf(logical.entry), fill, marker)
            const target = localeFiles.find((file) => file.layer === writeLayer(logical.key))
            const count =
              logical.entry.plural === undefined
                ? 0
                : (target?.catalog.pluralForms ?? gettextForms(locale) ?? 2)
            const where = queue(logical.key, {
              key: logical.key,
              value: text,
              base: logical.entry,
              ...(count ? { forms: Array.from({ length: count }, () => text) } : {}),
            })
            missing.push({ bundle: id, key: logical.key, locale, ...where })
            stat.missing++
            continue
          }
          if (!judge(logical.key, logical.entry, provided)) continue
          placeholderCheck(logical.key, logical.entry, provided, false)
          if (logical.entry.plural !== undefined) {
            const entry = provided.entry
            const expected =
              provided.file.catalog.pluralForms ?? gettextForms(locale) ?? entry.forms?.length ?? 1
            const forms = entry.forms ?? []
            const lacking: string[] = []
            for (let i = 0; i < expected; i++) if (!forms[i]?.trim()) lacking.push(`[${i}]`)
            if (lacking.length)
              plurals.push({
                bundle: id,
                key: logical.key,
                locale,
                file: provided.file.file,
                missing: lacking,
              })
          }
          continue
        }

        const { ordinal, variants } = logical.plural
        const required = requiredCategories(locale, ordinal)
        const present = required.filter((category) => entries.has(pluralKey(logical.key, category)))
        const anyPresent = PLURAL_CATEGORIES.some((category) =>
          entries.has(pluralKey(logical.key, category)),
        )
        const lacking = required.filter((category) => !present.includes(category))
        const baseFor = (category: PluralCategory) => variants.get(category) ?? logical.entry
        let where: { layer: string; file?: string } | undefined
        for (const category of lacking) {
          const variantKey = pluralKey(logical.key, category)
          where = queue(variantKey, {
            key: variantKey,
            value: fillValue(textOf(baseFor(category)), fill, marker),
          })
        }
        if (!anyPresent) {
          missing.push({ bundle: id, key: logical.key, locale, ...where })
          stat.missing++
          continue
        }
        const shown =
          entries.get(pluralKey(logical.key, 'other')) ??
          entries.get(pluralKey(logical.key, present[0] ?? 'other'))
        if (lacking.length && shown)
          plurals.push({
            bundle: id,
            key: logical.key,
            locale,
            file: shown.file.file,
            missing: lacking,
          })
        if (shown && !judge(logical.key, logical.entry, shown)) continue
        for (const category of PLURAL_CATEGORIES) {
          const provided = entries.get(pluralKey(logical.key, category))
          if (provided)
            placeholderCheck(pluralKey(logical.key, category), baseFor(category), provided, true)
        }
      }

      for (const [key, provided] of entries) {
        if (baseMerged.has(key) || isIgnored(key, namespace)) continue
        const suffix = pluralSuffix(key)
        if (suffix && baseStems.has(suffix.stem)) continue
        extra.push({ bundle: id, key, locale, file: provided.file.file })
        stat.extra++
      }

      if (mode !== 'suggest' || stat.optional) continue
      for (const item of pending.values()) {
        if (!item.source.insert) continue
        const oldText = item.file?.text
        const newText = item.source.insert(
          oldText ?? EMPTY_CATALOG[item.source.format] ?? '',
          item.inserts,
          item.order,
        )
        if (newText === oldText) continue
        const target = layerById.get(item.layer)?.target
        const noun = item.keys.length === 1 ? 'key' : 'keys'
        changes.push({
          id: `i18n:missing:${target ? `${target.forge}:${target.path}:` : ''}${item.path}`,
          title: `Add ${item.keys.length} missing ${noun} to ${item.path}`,
          description: `Copied from \`${baseLocale}\`${fill === 'todo' ? ` with a \`${marker.trim()}\` marker` : fill === 'empty' ? ' as empty values' : ''} into layer \`${item.layer}\`; translate before merging.\n\n${listed(item.keys)}`,
          confidence: 'review',
          source: 'i18n',
          ...(target ? { target } : {}),
          edits: [
            oldText === undefined
              ? { kind: 'create', file: item.path, newText }
              : wholeFileEdit(item.path, oldText, newText),
          ],
        })
      }
    }
  }

  for (const stat of stats.values())
    stat.completeness = total === 0 ? 100 : Math.round((stat.translated / total) * 1000) / 10

  const usage = options.usage
  const unused: UnusedKey[] = []
  const missingInBase: KeyUsage[] = []
  if (usage && bundles.length) {
    const namespaces = new Set(bundles.flatMap((b) => (b.info.namespace ? [b.info.namespace] : [])))
    const used = new Set<string>()
    const usedPrefixes: string[] = []
    const keyed = [...baseKeys].flatMap(([bundle, keys]) =>
      keys.map((k) => ({ bundle, key: k.key, logical: k })),
    )
    const split = (key: string, explicit?: string) => {
      const colon = key.indexOf(':')
      if (!explicit && colon > 0 && namespaces.has(key.slice(0, colon)))
        return { namespace: key.slice(0, colon), key: key.slice(colon + 1) }
      return { namespace: explicit, key }
    }
    const byKey = Map.groupBy(keyed, (k) => k.key)
    for (const reference of usage.keys) {
      const { namespace, key } = split(reference.key, reference.namespace)
      if (!key || isIgnored(key, namespace)) continue
      const inNamespace = (k: (typeof keyed)[number]) =>
        !namespace || k.bundle.info.namespace === namespace
      const exact = (byKey.get(key) ?? []).filter(inNamespace)
      const found = exact.length
        ? exact
        : keyed.filter((k) => k.key.startsWith(`${key}.`) && inNamespace(k))
      if (found.length) for (const k of found) used.add(`${k.bundle.info.id}\0${k.key}`)
      else missingInBase.push(reference)
    }
    for (const dynamic of usage.dynamic)
      if (dynamic.prefix) usedPrefixes.push(split(dynamic.prefix).key)
    if (usage.keys.length || usage.dynamic.length) {
      for (const { bundle, key, logical } of keyed) {
        if (used.has(`${bundle.info.id}\0${key}`)) continue
        if (usedPrefixes.some((prefix) => key.startsWith(prefix))) continue
        const layer = logical.provided.file.layer
        unused.push({
          bundle: bundle.info.id,
          key,
          layer,
          shared: layerById.get(layer)?.info.shared ?? false,
        })
      }
    }
    if (mode === 'suggest') {
      for (const bundle of bundles) {
        const keys = new Set(
          unused.filter((u) => u.bundle === bundle.info.id && !u.shared).map((u) => u.key),
        )
        if (keys.size === 0) continue
        const byTarget = new Map<string, { target?: ChangeTarget; edits: Edit[] }>()
        for (const file of [...bundle.files.values()].flat()) {
          const layer = layerById.get(file.layer)
          if (!file.source.remove || layer?.info.shared) continue
          const remove = file.catalog.entries
            .map((entry) => entry.key)
            .filter((key) => keys.has(key) || keys.has(pluralSuffix(key)?.stem ?? '\0'))
          if (remove.length === 0) continue
          const newText = file.source.remove(file.text, remove)
          if (newText === file.text) continue
          const targetKey = layer?.target ? `${layer.target.forge}:${layer.target.path}` : ''
          const group = byTarget.get(targetKey) ?? {
            ...(layer?.target ? { target: layer.target } : {}),
            edits: [],
          }
          group.edits.push(wholeFileEdit(file.file, file.text, newText))
          byTarget.set(targetKey, group)
        }
        for (const [targetKey, group] of byTarget) {
          changes.push({
            id: `i18n:unused:${targetKey ? `${targetKey}:` : ''}${bundle.info.id}`,
            title: `Remove ${keys.size} unused ${keys.size === 1 ? 'key' : 'keys'} from ${bundle.info.id}`,
            description: `No static call or dynamic prefix uses these keys; check for keys built at run time first.\n\n${listed([...keys])}`,
            confidence: 'review',
            source: 'i18n',
            ...(group.target ? { target: group.target } : {}),
            edits: group.edits,
          })
        }
      }
    }
  }

  return {
    baseLocale,
    mode,
    layers: layers.map((layer) => ({
      ...layer.info,
      catalogs: options.files.filter((file) => file.layer === layer.info.id).length,
    })),
    provenance,
    overrides,
    formats: [...new Set(bundles.flatMap((b) => b.info.formats))].toSorted(),
    bundles: bundles.map((b) => b.info),
    locales: locales.map((locale) => stats.get(locale)!),
    keys: total,
    missing,
    extra,
    untranslated,
    placeholders,
    plurals,
    usage: {
      files: usage?.files ?? 0,
      references: usage?.keys.length ?? 0,
      missingInBase,
      unused,
      dynamic: [...(usage?.dynamic ?? [])],
    },
    changes,
  }
}

/** Base key order with plural groups expanded to the categories `locale` uses. */
function desiredOrder(keys: readonly LogicalKey[], locale: string): string[] {
  const order: string[] = []
  for (const logical of keys) {
    if (!logical.plural) order.push(logical.key)
    else {
      const wanted = new Set<PluralCategory>([
        ...requiredCategories(locale, logical.plural.ordinal),
        ...logical.plural.variants.keys(),
      ])
      for (const category of PLURAL_CATEGORIES)
        if (wanted.has(category)) order.push(pluralKey(logical.key, category))
    }
  }
  return order
}
