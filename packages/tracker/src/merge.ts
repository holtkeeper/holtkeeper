import { normalizeKey, type NormalizeStep } from './normalize.ts'
import type { SourceHit } from './sources/types.ts'
import type { Entity, MergedAttr, Occurrence, Provenance } from './types.ts'

const precedence = ['definition', 'documentation', 'config', 'usage']

/** Rank of a role when attribute values disagree; lower wins, unknown roles come last. */
const rank = (role: string) => {
  const index = precedence.indexOf(role)
  return index < 0 ? precedence.length : index
}

const provenanceOf = (occurrence: Occurrence): Provenance => ({
  source: occurrence.source,
  role: occurrence.role,
  ...(occurrence.repo ? { repo: occurrence.repo } : {}),
  ...(occurrence.file ? { file: occurrence.file } : {}),
  ...(occurrence.line ? { line: occurrence.line } : {}),
  ...(occurrence.document
    ? { document: occurrence.document.title ?? occurrence.document.ref }
    : {}),
})

/** Merged attributes of occurrences without an environment: the best-ranked first value wins. */
export function mergeAttrs(occurrences: readonly Occurrence[]): Record<string, MergedAttr> {
  const ordered = occurrences
    .map((occurrence, index) => ({ occurrence, index }))
    .filter(({ occurrence }) => !occurrence.environment)
    .toSorted((a, b) => rank(a.occurrence.role) - rank(b.occurrence.role) || a.index - b.index)
  const merged: Record<string, MergedAttr> = {}
  for (const { occurrence } of ordered) {
    for (const [name, value] of Object.entries(occurrence.attrs)) {
      const from = provenanceOf(occurrence)
      const current = merged[name]
      if (!current) {
        merged[name] = { value, from }
        continue
      }
      const values = current.values ?? [{ value: current.value, from: current.from }]
      if (!values.some((entry) => entry.value === value)) {
        values.push({ value, from })
        current.values = values
      }
    }
  }
  return merged
}

/** Attributes per environment; for each attribute the best-ranked first value wins. */
export function environmentAttrs(
  occurrences: readonly Occurrence[],
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  const ordered = occurrences
    .map((occurrence, index) => ({ occurrence, index }))
    .filter(({ occurrence }) => occurrence.environment)
    .toSorted((a, b) => rank(a.occurrence.role) - rank(b.occurrence.role) || a.index - b.index)
  for (const { occurrence } of ordered) {
    const values = (result[occurrence.environment!] ??= {})
    for (const [name, value] of Object.entries(occurrence.attrs)) values[name] ??= value
  }
  return result
}

/** Entities from raw source hits: keys normalized, spellings kept as labels, sorted by key. */
export function buildEntities(
  hits: readonly SourceHit[],
  normalize: readonly NormalizeStep[],
): Entity[] {
  const byKey = new Map<string, { labels: string[]; occurrences: Occurrence[] }>()
  for (const hit of hits) {
    const raw = hit.key.trim()
    const key = normalizeKey(raw, normalize)
    if (!key) continue
    const entry = byKey.get(key) ?? { labels: [], occurrences: [] }
    byKey.set(key, entry)
    if (!entry.labels.includes(raw)) entry.labels.push(raw)
    entry.occurrences.push({
      ...hit.occurrence,
      ...(hit.line ? { line: hit.line } : {}),
      ...(raw === key ? {} : { raw }),
      attrs: hit.attrs,
    })
  }
  return [...byKey]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, { labels, occurrences }]) => ({
      key,
      labels,
      attrs: mergeAttrs(occurrences),
      environments: environmentAttrs(occurrences),
      occurrences,
    }))
}
