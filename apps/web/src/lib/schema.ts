import { initialValue } from './schema-form.ts'

/** Which editor a setting value gets, derived from its JSON Schema. */
export type EditorKind =
  | { kind: 'secret' }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'number'; integer: boolean }
  | { kind: 'string' }
  | { kind: 'json' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isConstVariant = (value: unknown): value is { const: string } =>
  isRecord(value) && typeof value.const === 'string'

/** Picks an editor for a JSON Schema. Unknown or compound schemas fall back to a JSON editor. */
export function editorFor(schema: unknown, secret: boolean): EditorKind {
  if (secret) return { kind: 'secret' }
  if (!isRecord(schema)) return { kind: 'json' }
  const values = schema.enum
  if (Array.isArray(values) && values.every((v) => typeof v === 'string')) {
    return { kind: 'enum', options: values }
  }
  const variants = schema.anyOf ?? schema.oneOf
  if (Array.isArray(variants) && variants.length > 0 && variants.every(isConstVariant)) {
    return { kind: 'enum', options: variants.map((v) => v.const) }
  }
  switch (schema.type) {
    case 'boolean':
      return { kind: 'boolean' }
    case 'string':
      return { kind: 'string' }
    case 'integer':
      return { kind: 'number', integer: true }
    case 'number':
      return { kind: 'number', integer: false }
    default:
      return { kind: 'json' }
  }
}

/** Default value for a new entry of a schema. */
export function defaultValue(schema: unknown): unknown {
  if (isRecord(schema)) {
    if ('default' in schema) return schema.default
    const editor = editorFor(schema, false)
    switch (editor.kind) {
      case 'boolean':
        return false
      case 'enum':
        return editor.options[0] ?? ''
      case 'number':
        return 0
      case 'string':
        return ''
      default:
        return initialValue(schema, schema)
    }
  }
  return null
}

/** Parses JSON editor text; returns the value or an error message. */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Short one-line preview of a stored value. */
export function previewValue(value: unknown, secret: boolean): string {
  if (secret) return value === null ? 'set' : '••••••'
  if (value === undefined) return '—'
  if (typeof value === 'string') return value === '' ? '""' : value
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  const text = JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}
