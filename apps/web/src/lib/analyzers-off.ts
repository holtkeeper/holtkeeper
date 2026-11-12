import { describeField } from './schema-form.ts'

/** One analyzer `repo.analyzers` may turn off, as its definition offers it. */
export interface AnalyzerOption {
  id: string
  label: string
}

/**
 * The analyzers the `repo.analyzers` definition accepts in `off`, labelled as the server labels
 * them; empty when its schema offers none.
 */
export function analyzerOptions(schema: unknown): AnalyzerOption[] {
  const root = describeField(schema, schema)
  if (root.kind !== 'object') return []
  const off = root.properties.find((property) => property.name === 'off')
  const node = off && describeField(off.schema, schema)
  if (node?.kind !== 'multi') return []
  return node.options.map((id) => ({ id, label: node.labels?.[id] ?? id }))
}

/** A `repo.analyzers` value as the panel reads it: the kinds that are off and why. */
export function readAnalyzersOff(value: unknown): { off: string[]; reason: string } {
  const record = typeof value === 'object' && value !== null ? value : {}
  const off: unknown = Reflect.get(record, 'off')
  const reason: unknown = Reflect.get(record, 'reason')
  return {
    off: Array.isArray(off) ? off.filter((kind) => typeof kind === 'string') : [],
    reason: typeof reason === 'string' ? reason : '',
  }
}

/**
 * The `repo.analyzers` value the panel writes: the reason only while some analyzer is off and it
 * is not blank, so an entry turning everything back on is `{ off: [] }`.
 */
export function analyzersOffValue(off: readonly string[], reason: string) {
  return off.length && reason.trim() ? { off: [...off], reason } : { off: [...off] }
}
