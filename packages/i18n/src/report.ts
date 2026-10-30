import { changeDiff } from '@holtkeeper/changes'
import {
  type Block,
  type Cell,
  defineAnalysis,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
} from '@holtkeeper/report'

import { i18nDataSchema } from './schema.ts'
import { CONTEXT_SEPARATOR } from './sources/po.ts'
import type { I18nData } from './types.ts'

const MAX_ROWS = 500

const shownKey = (key: string) => key.replace(CONTEXT_SEPARATOR, ' | ')

const averageCompleteness = (data: I18nData) => {
  const others = data.locales.filter((l) => !l.base && !l.optional)
  if (others.length === 0) return 100
  return Math.round((others.reduce((sum, l) => sum + l.completeness, 0) / others.length) * 10) / 10
}

const ownUnused = (data: I18nData) => data.usage.unused.filter((u) => !u.shared)

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })

const toned = (m: Metric, bad: boolean): Metric => (bad ? { ...m, tone: 'bad' } : m)

function metricsOf(data: I18nData, previous?: I18nData): Metric[] {
  return [
    metric('locales', 'Locales', data.locales.length, prev(previous?.locales.length)),
    metric('keys', 'Keys', data.keys, { ...prev(previous?.keys), hint: `in ${data.baseLocale}` }),
    metric('completeness', 'Completeness', averageCompleteness(data), {
      unit: 'percent',
      ...prev(previous ? averageCompleteness(previous) : undefined),
      better: 'up',
      hint: 'average over non-base locales',
    }),
    toned(
      metric('missing', 'Missing', data.missing.length, {
        ...prev(previous?.missing.length),
        better: 'down',
      }),
      data.missing.length > 0,
    ),
    metric('untranslated', 'Untranslated', data.untranslated.length, {
      ...prev(previous?.untranslated.length),
      better: 'down',
    }),
    metric('unused', 'Unused', ownUnused(data).length, {
      ...prev(previous ? ownUnused(previous).length : undefined),
      better: 'down',
      ...(data.usage.unused.length > ownUnused(data).length
        ? { hint: `${data.usage.unused.length - ownUnused(data).length} more in shared layers` }
        : {}),
    }),
    toned(
      metric('placeholders', 'Placeholder errors', data.placeholders.length, {
        ...prev(previous?.placeholders.length),
        better: 'down',
      }),
      data.placeholders.length > 0,
    ),
    metric('plurals', 'Plural gaps', data.plurals.length, {
      ...prev(previous?.plurals.length),
      better: 'down',
    }),
    toned(
      metric('missingInBase', 'Used, not in base', data.usage.missingInBase.length, {
        ...prev(previous?.usage.missingInBase.length),
        better: 'down',
      }),
      data.usage.missingInBase.length > 0,
    ),
  ]
}

const idOf = (item: { bundle: string; key: string; locale?: string }) =>
  `${item.bundle}\0${item.key}\0${item.locale ?? ''}`

/** `new` / `resolved` counts of a list against the previous record's. */
function compare<T extends { bundle: string; key: string; locale?: string }>(
  now: readonly T[],
  before: readonly T[] | undefined,
) {
  if (!before) return { isNew: () => false, resolved: 0, added: 0 }
  const old = new Set(before.map(idOf))
  const current = new Set(now.map(idOf))
  return {
    isNew: (item: T) => !old.has(idOf(item)),
    added: now.filter((item) => !old.has(idOf(item))).length,
    resolved: [...old].filter((id) => !current.has(id)).length,
  }
}

const changeText = (added: number, resolved: number, hasPrevious: boolean) =>
  hasPrevious ? ` ${added} new, ${resolved} resolved since the previous analysis.` : ''

function completeness(data: I18nData, previous?: I18nData): Section {
  const before = new Map(previous?.locales.map((l) => [l.locale, l.completeness]))
  const blocks: Block[] = []
  const external = data.layers.filter((l) => l.repo)
  if (external.length) {
    const repos = [...new Set(external.map((l) => `\`${l.repo!.forge}:${l.repo!.path}\``))].join(
      ', ',
    )
    blocks.push({
      type: 'markdown',
      text: `Catalogs are merged from ${data.layers.length} layers; ${repos} ${external.length === 1 ? 'is' : 'are'} outside this repository. Source usage is scanned in this repository.${data.mode === 'suggest' ? ' Changes to those layers open merge requests there.' : ''}`,
    })
  }
  blocks.push(
    {
      type: 'chart',
      title: 'Completeness per locale',
      chart: 'bar',
      unit: 'percent',
      x: 'locale',
      series: [{ key: 'completeness', label: 'Translated', tone: 'good' }],
      data: data.locales.map((l) => ({ locale: l.locale, completeness: l.completeness })),
    },
    {
      type: 'table',
      columns: [
        { key: 'locale', label: 'Locale', format: 'code' },
        { key: 'completeness', label: 'Completeness', unit: 'percent', align: 'end' },
        ...(previous
          ? [
              {
                key: 'delta',
                label: 'Change',
                unit: 'percent' as const,
                format: 'delta' as const,
                better: 'up' as const,
                align: 'end' as const,
              },
            ]
          : []),
        { key: 'translated', label: 'Translated', unit: 'count', align: 'end' },
        { key: 'missing', label: 'Missing', unit: 'count', align: 'end' },
        { key: 'untranslated', label: 'Untranslated', unit: 'count', align: 'end' },
        { key: 'extra', label: 'Only here', unit: 'count', align: 'end' },
      ],
      rows: data.locales.map((l) => {
        const was = before.get(l.locale)
        return {
          locale: l.base
            ? { text: l.locale, hint: 'base locale' }
            : l.optional
              ? { text: l.locale, hint: 'optional' }
              : l.locale,
          completeness: {
            text: `${l.completeness}%`,
            tone: l.completeness >= 99.9 ? 'good' : l.completeness >= 90 ? 'warning' : 'bad',
          },
          ...(previous
            ? { delta: was === undefined ? null : Math.round((l.completeness - was) * 10) / 10 }
            : {}),
          translated: l.translated,
          missing: l.missing,
          untranslated: l.untranslated,
          extra: l.extra,
        }
      }),
    },
  )
  if (data.bundles.length) {
    blocks.push({
      type: 'table',
      title: 'Catalogs',
      columns: [
        { key: 'bundle', label: 'Catalog', format: 'code' },
        { key: 'format', label: 'Format' },
        { key: 'locales', label: 'Locales', format: 'tags' },
        { key: 'layers', label: 'Layers', format: 'tags' },
      ],
      rows: data.bundles.map((b) => ({
        bundle: b.id,
        format: b.formats.join(', '),
        locales: [...new Set(b.files.map((f) => f.locale))].join(', '),
        layers: [...new Set(b.files.map((f) => f.layer))].join(', '),
      })),
    })
  }
  return { id: 'completeness', title: 'Completeness', blocks }
}

function missingKeys(data: I18nData, previous?: I18nData): Section | undefined {
  const blocks: Block[] = []
  const diff = compare(data.missing, previous?.missing)
  const grouped = new Map<
    string,
    { bundle: string; key: string; locales: Set<string>; layers: Set<string>; isNew: boolean }
  >()
  for (const item of data.missing) {
    const id = `${item.bundle}\0${item.key}`
    const row = grouped.get(id) ?? {
      bundle: item.bundle,
      key: item.key,
      locales: new Set(),
      layers: new Set(),
      isNew: false,
    }
    row.locales.add(item.locale)
    if (item.layer) row.layers.add(item.layer)
    row.isNew ||= diff.isNew(item)
    grouped.set(id, row)
  }
  const locales = data.locales.filter((l) => !l.base && l.missing > 0).map((l) => l.locale)
  if (grouped.size) {
    const rows = [...grouped.values()].slice(0, MAX_ROWS).map((row) => {
      const cells: Record<string, Cell> = {
        key: row.isNew
          ? { text: shownKey(row.key), tone: 'warning', hint: 'new' }
          : shownKey(row.key),
        bundle: row.bundle,
        layer: [...row.layers].join(', '),
      }
      for (const locale of locales)
        cells[`l:${locale}`] = row.locales.has(locale) ? { text: 'missing', tone: 'bad' } : ''
      return cells
    })
    blocks.push({
      type: 'table',
      title: grouped.size > MAX_ROWS ? `First ${MAX_ROWS} of ${grouped.size} keys` : undefined,
      columns: [
        { key: 'key', label: 'Key', format: 'code' },
        { key: 'bundle', label: 'Catalog', format: 'code' },
        ...(data.layers.length > 1
          ? [{ key: 'layer', label: 'Write to', format: 'tags' as const }]
          : []),
        ...locales.map((locale) => ({ key: `l:${locale}`, label: locale })),
      ],
      rows,
      ...(data.bundles.length > 1 ? { groupBy: 'bundle' } : {}),
    })
  }
  if (data.layers.length > 1 && data.missing.length) {
    const layerIds = [...new Set(data.missing.map((m) => m.layer ?? ''))]
    blocks.push({
      type: 'table',
      title: 'Missing per layer and locale',
      columns: [
        { key: 'layer', label: 'Layer', format: 'code' },
        ...locales.map((locale) => ({
          key: `l:${locale}`,
          label: locale,
          unit: 'count' as const,
          align: 'end' as const,
        })),
      ],
      rows: layerIds.map((layer) => {
        const row: Record<string, Cell> = { layer: layer || '(none)' }
        for (const locale of locales)
          row[`l:${locale}`] = data.missing.filter(
            (m) => (m.layer ?? '') === layer && m.locale === locale,
          ).length
        return row
      }),
    })
  }
  if (data.untranslated.length) {
    blocks.push({
      type: 'table',
      title: 'Untranslated values',
      columns: [
        { key: 'key', label: 'Key', format: 'code' },
        { key: 'locale', label: 'Locale', format: 'code' },
        { key: 'reason', label: 'Why' },
        { key: 'file', label: 'File', format: 'code' },
      ],
      rows: data.untranslated.slice(0, MAX_ROWS).map((u) => ({
        key: shownKey(u.key),
        locale: u.locale,
        reason: u.reason === 'identical' ? `same as ${data.baseLocale}` : u.reason,
        file: u.file,
      })),
    })
  }
  if (data.extra.length) {
    blocks.push({
      type: 'table',
      title: 'Keys only in non-base locales',
      columns: [
        { key: 'key', label: 'Key', format: 'code' },
        { key: 'locale', label: 'Locale', format: 'code' },
        { key: 'file', label: 'File', format: 'code' },
      ],
      rows: data.extra
        .slice(0, MAX_ROWS)
        .map((e) => ({ key: shownKey(e.key), locale: e.locale, file: e.file })),
    })
  }
  if (blocks.length === 0) return undefined
  return {
    id: 'missing',
    title: 'Missing keys',
    description: `Keys of \`${data.baseLocale}\` other locales lack.${changeText(diff.added, diff.resolved, Boolean(previous))}`,
    blocks,
  }
}

function placeholderSection(data: I18nData, previous?: I18nData): Section | undefined {
  const placeholderDiff = compare(data.placeholders, previous?.placeholders)
  const pluralDiff = compare(data.plurals, previous?.plurals)
  const items: Issue[] = [
    ...data.placeholders.map((p) => ({
      id: `placeholder:${idOf(p)}`,
      tone: 'bad' as const,
      title: `${shownKey(p.key)} (${p.locale})`,
      detail: [
        p.missing.length ? `missing ${p.missing.map((t) => `\`${t}\``).join(', ')}` : '',
        p.unexpected.length ? `unexpected ${p.unexpected.map((t) => `\`${t}\``).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')
        .concat(` in ${p.file}`),
      tags: ['placeholder', p.locale, ...(placeholderDiff.isNew(p) ? ['new'] : [])],
    })),
    ...data.plurals.map((p) => ({
      id: `plural:${idOf(p)}`,
      tone: 'warning' as const,
      title: `${shownKey(p.key)} (${p.locale})`,
      detail: `missing plural forms ${p.missing.join(', ')} in ${p.file}`,
      tags: ['plural', p.locale, ...(pluralDiff.isNew(p) ? ['new'] : [])],
    })),
  ]
  if (items.length === 0) return undefined
  return {
    id: 'placeholders',
    title: 'Placeholders and plurals',
    description: `Placeholders compared with \`${data.baseLocale}\`; plural forms checked against the CLDR categories of each locale.${changeText(placeholderDiff.added + pluralDiff.added, placeholderDiff.resolved + pluralDiff.resolved, Boolean(previous))}`,
    blocks: [{ type: 'issues', items: items.slice(0, MAX_ROWS) }],
  }
}

const at = (u: { file: string; line: number; column: number }) => `${u.file}:${u.line}:${u.column}`

function usageSection(data: I18nData, previous?: I18nData): Section | undefined {
  const { usage } = data
  if (usage.files === 0) return undefined
  const blocks: Block[] = []
  const before = new Set(previous?.usage.missingInBase.map((u) => u.key))
  const byKey = Map.groupBy(usage.missingInBase, (u) =>
    u.namespace ? `${u.namespace}:${u.key}` : u.key,
  )
  if (byKey.size) {
    blocks.push({
      type: 'issues',
      title: 'Used in code, missing in the base locale',
      items: [...byKey].slice(0, MAX_ROWS).map(([key, uses]) => ({
        id: `usage:${key}`,
        tone: 'bad',
        title: key,
        detail:
          uses.slice(0, 5).map(at).join(', ') +
          (uses.length > 5 ? ` and ${uses.length - 5} more` : ''),
        tags:
          previous && !before.has(uses[0]!.key) ? ['missing-in-base', 'new'] : ['missing-in-base'],
      })),
    })
  }
  const own = ownUnused(data)
  if (own.length) {
    blocks.push({
      type: 'table',
      title: 'Unused keys',
      columns: [
        { key: 'key', label: 'Key', format: 'code' },
        { key: 'bundle', label: 'Catalog', format: 'code' },
        ...(data.layers.length > 1
          ? [{ key: 'layer', label: 'Layer', format: 'code' as const }]
          : []),
      ],
      rows: own
        .slice(0, MAX_ROWS)
        .map((u) => ({ key: shownKey(u.key), bundle: u.bundle, layer: u.layer })),
    })
  }
  const shared = usage.unused.filter((u) => u.shared)
  if (shared.length) {
    blocks.push({
      type: 'table',
      title: `Shared keys this project does not use (${shared.length}, informational: other projects may)`,
      columns: [
        { key: 'key', label: 'Key', format: 'code' },
        { key: 'bundle', label: 'Catalog', format: 'code' },
        { key: 'layer', label: 'Layer', format: 'code' },
      ],
      rows: shared
        .slice(0, MAX_ROWS)
        .map((u) => ({ key: shownKey(u.key), bundle: u.bundle, layer: u.layer })),
    })
  }
  if (usage.dynamic.length) {
    blocks.push({
      type: 'table',
      title: `Dynamic usages (${usage.dynamic.length})`,
      columns: [
        { key: 'text', label: 'Key expression', format: 'code' },
        { key: 'prefix', label: 'Static prefix', format: 'code' },
        { key: 'at', label: 'Location', format: 'code' },
      ],
      rows: usage.dynamic
        .slice(0, MAX_ROWS)
        .map((d) => ({ text: d.text, prefix: d.prefix ?? null, at: at(d) })),
    })
  }
  return {
    id: 'usage',
    title: 'Usage',
    description: `${usage.references} static translation calls in ${usage.files} source files; ${usage.dynamic.length} dynamic. Keys under a dynamic prefix count as used.`,
    blocks: blocks.length
      ? blocks
      : [{ type: 'markdown', text: 'Every key used in code exists, and every key is used.' }],
  }
}

function layersSection(data: I18nData): Section | undefined {
  if (data.layers.length < 2) return undefined
  const sharedLayers = new Set(data.layers.filter((l) => l.shared).map((l) => l.id))
  const effective = Map.groupBy(data.provenance, (p) => p.layer)
  const blocks: Block[] = [
    {
      type: 'table',
      title: 'Layers in merge order',
      columns: [
        { key: 'id', label: 'Layer', format: 'code' },
        { key: 'repo', label: 'Repository', format: 'code' },
        { key: 'files', label: 'Files', format: 'code' },
        { key: 'catalogs', label: 'Catalogs', unit: 'count', align: 'end' },
        { key: 'keys', label: 'Base keys used from it', unit: 'count', align: 'end' },
      ],
      rows: data.layers.map((l) => ({
        id: l.shared ? { text: l.id, hint: 'shared' } : l.id,
        repo: l.repo
          ? `${l.repo.forge}:${l.repo.path}${l.ref ? `@${l.ref}` : ''}`
          : 'this repository',
        files: l.files ?? null,
        catalogs: l.catalogs,
        keys: effective.get(l.id)?.length ?? 0,
      })),
    },
  ]
  const shadowing = data.overrides.filter(
    (o) => !sharedLayers.has(o.layer) && o.overrides.some((layer) => sharedLayers.has(layer)),
  )
  if (shadowing.length) {
    blocks.push({
      type: 'issues',
      title: 'Overrides of shared keys',
      items: shadowing.slice(0, MAX_ROWS).map((o) => ({
        id: `override:${o.bundle}\0${o.key}\0${o.locale}`,
        tone: 'info',
        title: `${shownKey(o.key)} (${o.locale})`,
        detail: `\`${o.layer}\` overrides ${o.overrides.map((l) => `\`${l}\``).join(', ')} in ${o.bundle}`,
        tags: ['override', o.layer],
      })),
    })
  }
  blocks.push({
    type: 'table',
    title: 'Key provenance',
    columns: [
      { key: 'key', label: 'Key', format: 'code' },
      { key: 'bundle', label: 'Catalog', format: 'code' },
      { key: 'layer', label: 'Defined by', format: 'code' },
      { key: 'overrides', label: 'Overrides', format: 'tags' },
    ],
    rows: data.provenance.slice(0, MAX_ROWS).map((p) => ({
      key: shownKey(p.key),
      bundle: p.bundle,
      layer: p.layer,
      overrides: p.layers.slice(0, -1).join(', '),
    })),
  })
  return {
    id: 'layers',
    title: 'Layers',
    description: 'Later layers override earlier ones for the same key.',
    blocks,
  }
}

function sectionsOf(data: I18nData, previous?: I18nData): Section[] {
  const sections: Section[] = [completeness(data, previous)]
  for (const section of [
    layersSection(data),
    missingKeys(data, previous),
    placeholderSection(data, previous),
    usageSection(data, previous),
  ])
    if (section) sections.push(section)
  if (data.changes.length) {
    sections.push({
      id: 'changes',
      title: 'Suggested changes',
      description:
        'Missing keys are copied from the base locale for translators to fill; unused keys are removed in a separate change. Both rewrite whole catalog files, so accept one and re-run before the other.',
      blocks: [
        {
          type: 'changes',
          items: data.changes.map((change) => ({
            change,
            diff: changeDiff(change),
            tone: change.id.startsWith('i18n:unused:') ? 'warning' : 'info',
            tags: [change.id.startsWith('i18n:unused:') ? 'unused' : 'missing'],
          })),
          applicable: true,
        },
      ],
    })
  }
  return sections
}

/** The `i18n` analysis kind: translation completeness, placeholder and plural checks, usage. */
export const i18nAnalysis = defineAnalysis<I18nData>({
  kind: 'i18n',
  label: 'Translations',
  schema: i18nDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const before = previous?.data
    return {
      kind: 'i18n',
      title: 'Translations',
      subtitle: `${data.locales.length} locales, base ${data.baseLocale}${data.formats.length ? ` · ${data.formats.join(', ')}` : ''}`,
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, before),
      sections: sectionsOf(data, before),
    }
  },
  changes: (data) => data.changes,
})
