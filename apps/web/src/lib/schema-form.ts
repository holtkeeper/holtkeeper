export type JsonSchema = Record<string, unknown>

export interface Property {
  name: string
  schema: JsonSchema
  required: boolean
}

export interface Variant {
  label: string
  schema: JsonSchema
}

export interface NumberRules {
  integer: boolean
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
}

export interface StringRules {
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
}

/** How one value of a JSON Schema is edited in a form. */
export type FieldNode =
  | { kind: 'any' }
  | { kind: 'fixed'; value: unknown }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  | ({ kind: 'string' } & StringRules)
  | ({ kind: 'number' } & NumberRules)
  | { kind: 'credential'; of: string }
  | { kind: 'credentials'; of: string }
  | { kind: 'tags'; item: FieldNode }
  | { kind: 'multi'; options: string[] }
  | { kind: 'list'; item: JsonSchema }
  | { kind: 'object'; properties: Property[] }
  | { kind: 'record'; value: JsonSchema; key: StringRules }
  | { kind: 'variants'; variants: Variant[]; discriminator?: string }

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const num = (value: unknown) => (typeof value === 'number' ? value : undefined)
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

const child = (schema: JsonSchema, ...path: string[]): JsonSchema | undefined => {
  let current: unknown = schema
  for (const part of path) current = isRecord(current) ? current[part] : undefined
  return isRecord(current) ? current : undefined
}

/** Follows local `#/$defs/...` references against the root schema. */
export function resolve(schema: unknown, root: unknown): JsonSchema {
  let current = isRecord(schema) ? schema : {}
  for (let depth = 0; depth < 32 && typeof current.$ref === 'string'; depth++) {
    const path = current.$ref.replace(/^#\/?/, '').split('/').filter(Boolean)
    let target: unknown = root
    for (const part of path) target = isRecord(target) ? target[part] : undefined
    const { $ref: _, ...siblings } = current
    current = { ...(isRecord(target) ? target : {}), ...siblings }
  }
  return current
}

const variantsOf = (schema: JsonSchema): JsonSchema[] | undefined => {
  const list = schema.anyOf ?? schema.oneOf
  if (Array.isArray(list) && list.length > 0) return list.filter(isRecord)
  if (Array.isArray(schema.type)) {
    return schema.type.filter((t) => typeof t === 'string').map((type) => ({ type }))
  }
  return undefined
}

const constOf = (schema: JsonSchema) =>
  'const' in schema
    ? schema.const
    : Array.isArray(schema.enum) && schema.enum.length === 1
      ? schema.enum[0]
      : undefined

const discriminatorOf = (variants: JsonSchema[], root: unknown): string | undefined => {
  const resolved = variants.map((v) => resolve(v, root))
  if (!resolved.every((v) => isRecord(v.properties))) return undefined
  const [first] = resolved
  const candidates = Object.keys(child(first ?? {}, 'properties') ?? {})
  return candidates.find((name) => {
    const values = resolved.map((v) => {
      const property = child(v, 'properties', name)
      return property ? constOf(property) : undefined
    })
    return values.every((v) => typeof v === 'string') && new Set(values).size === values.length
  })
}

const typeLabels: Record<string, string> = {
  string: 'Text',
  number: 'Number',
  integer: 'Number',
  boolean: 'Yes / no',
  array: 'List',
  object: 'Fields',
  null: 'None',
}

function variantLabel(schema: JsonSchema, root: unknown, discriminator?: string): string {
  const resolved = resolve(schema, root)
  if (typeof resolved.title === 'string') return resolved.title
  if (discriminator) {
    const property = child(resolved, 'properties', discriminator)
    const value = property ? constOf(property) : undefined
    if (typeof value === 'string') return value
  }
  const fixed = constOf(resolved)
  if (fixed !== undefined) return String(fixed)
  if (typeof resolved.type === 'string') return typeLabels[resolved.type] ?? resolved.type
  return 'JSON'
}

const stringRules = (schema: JsonSchema): StringRules => ({
  minLength: num(schema.minLength),
  maxLength: num(schema.maxLength),
  pattern: str(schema.pattern),
})

const leafOf = (schema: JsonSchema): FieldNode | undefined => {
  const credential = schema['x-credential']
  if (typeof credential === 'string' && (schema.type ?? 'string') === 'string') {
    return { kind: 'credential', of: credential }
  }
  const values = schema.enum
  if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string')) {
    return values.length === 1
      ? { kind: 'fixed', value: values[0] }
      : { kind: 'enum', options: values }
  }
  switch (schema.type) {
    case 'boolean':
      return { kind: 'boolean' }
    case 'string':
      return { kind: 'string', ...stringRules(schema), format: str(schema.format) }
    case 'integer':
    case 'number':
      return {
        kind: 'number',
        integer: schema.type === 'integer',
        minimum: num(schema.minimum),
        maximum: num(schema.maximum),
        exclusiveMinimum: num(schema.exclusiveMinimum),
        exclusiveMaximum: num(schema.exclusiveMaximum),
      }
    default:
      return undefined
  }
}

/** Picks how a schema is edited. Anything it cannot describe becomes `any` (a JSON field). */
export function describeField(schema: unknown, root: unknown): FieldNode {
  const resolved = resolve(schema, root)
  if ('const' in resolved) return { kind: 'fixed', value: resolved.const }

  const variants = variantsOf(resolved)
  if (variants) {
    const resolvedVariants = variants.map((v) => resolve(v, root))
    const consts = resolvedVariants.map(constOf)
    if (consts.every((v) => typeof v === 'string')) return { kind: 'enum', options: consts }
    if (variants.length === 1 && variants[0]) return describeField(variants[0], root)
    const discriminator = discriminatorOf(variants, root)
    return {
      kind: 'variants',
      variants: variants.map((v) => ({ label: variantLabel(v, root, discriminator), schema: v })),
      discriminator,
    }
  }

  const leaf = leafOf(resolved)
  if (leaf) return leaf

  if (resolved.type === 'array') {
    const item = resolve(resolved.items, root)
    const itemNode = describeField(item, root)
    if (itemNode.kind === 'enum') return { kind: 'multi', options: itemNode.options }
    if (itemNode.kind === 'credential') return { kind: 'credentials', of: itemNode.of }
    if (itemNode.kind === 'string' || itemNode.kind === 'number') {
      return { kind: 'tags', item: itemNode }
    }
    return { kind: 'list', item }
  }

  if (resolved.type === 'object' || isRecord(resolved.properties)) {
    const properties = isRecord(resolved.properties) ? resolved.properties : {}
    const required = new Set(Array.isArray(resolved.required) ? resolved.required : [])
    const extra = resolved.additionalProperties
    if (Object.keys(properties).length === 0 && isRecord(extra)) {
      const key = resolve(resolved.propertyNames, root)
      return {
        kind: 'record',
        value: extra,
        key: stringRules(key),
      }
    }
    return {
      kind: 'object',
      properties: Object.entries(properties).map(([name, value]) => ({
        name,
        schema: isRecord(value) ? value : {},
        required: required.has(name),
      })),
    }
  }

  return { kind: 'any' }
}

/** Whether a value has the shape of a schema, deep enough to pick an `anyOf` variant. */
export function fits(schema: unknown, value: unknown, root: unknown): boolean {
  const resolved = resolve(schema, root)
  if ('const' in resolved) return Object.is(resolved.const, value)
  if (Array.isArray(resolved.enum)) return resolved.enum.includes(value)
  const variants = variantsOf(resolved)
  if (variants) return variants.some((v) => fits(v, value, root))
  switch (resolved.type) {
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object': {
      if (!isRecord(value)) return false
      const properties = isRecord(resolved.properties) ? resolved.properties : {}
      return Object.entries(properties).every(([name, property]) => {
        const fixed = isRecord(property) ? constOf(resolve(property, root)) : undefined
        return fixed === undefined || value[name] === fixed
      })
    }
    default:
      return true
  }
}

/** Index of the variant a value belongs to; the first variant when none fits. */
export function variantIndex(variants: readonly Variant[], value: unknown, root: unknown): number {
  const index = variants.findIndex((v) => fits(v.schema, value, root))
  return Math.max(index, 0)
}

/** A valid starting value for a new field, list item or variant: the default or the smallest fit. */
export function initialValue(schema: unknown, root: unknown): unknown {
  const resolved = resolve(schema, root)
  if ('default' in resolved) return structuredClone(resolved.default)
  const node = describeField(resolved, root)
  switch (node.kind) {
    case 'fixed':
      return node.value
    case 'boolean':
      return false
    case 'enum':
      return node.options[0] ?? ''
    case 'string':
    case 'credential':
      return ''
    case 'number':
      return node.exclusiveMinimum !== undefined
        ? node.integer
          ? Math.floor(node.exclusiveMinimum) + 1
          : node.exclusiveMinimum + 1
        : (node.minimum ?? 0)
    case 'tags':
    case 'multi':
    case 'credentials':
    case 'list':
      return []
    case 'record':
      return {}
    case 'object':
      return Object.fromEntries(
        node.properties
          .filter((p) => p.required)
          .map((p) => [p.name, initialValue(p.schema, root)]),
      )
    case 'variants': {
      const preferred =
        node.variants.find((v) => describeField(v.schema, root).kind !== 'any') ?? node.variants[0]
      return preferred ? initialValue(preferred.schema, root) : null
    }
    default:
      return null
  }
}

/** Why a string breaks its rules, if it does. */
export function stringError(rules: StringRules, value: string): string | undefined {
  if (rules.minLength !== undefined && value.length < rules.minLength) {
    return rules.minLength === 1 ? 'Required' : `At least ${rules.minLength} characters`
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    return `At most ${rules.maxLength} characters`
  }
  if (rules.pattern !== undefined && value !== '' && !new RegExp(rules.pattern, 'u').test(value)) {
    return rules.format === 'date'
      ? 'Enter a date as YYYY-MM-DD'
      : 'Does not match the expected format'
  }
  return undefined
}

/** Parses number input against its rules: the number, or why it is not accepted. */
export function parseNumber(
  rules: NumberRules,
  text: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(text)
  if (text.trim() === '' || !Number.isFinite(value)) return { ok: false, error: 'Enter a number' }
  if (rules.integer && !Number.isInteger(value)) return { ok: false, error: 'Enter a whole number' }
  if (rules.minimum !== undefined && value < rules.minimum) {
    return { ok: false, error: `At least ${rules.minimum}` }
  }
  if (rules.exclusiveMinimum !== undefined && value <= rules.exclusiveMinimum) {
    return { ok: false, error: `More than ${rules.exclusiveMinimum}` }
  }
  if (rules.maximum !== undefined && value > rules.maximum) {
    return { ok: false, error: `At most ${rules.maximum}` }
  }
  if (rules.exclusiveMaximum !== undefined && value >= rules.exclusiveMaximum) {
    return { ok: false, error: `Less than ${rules.exclusiveMaximum}` }
  }
  return { ok: true, value }
}

/** `maxResultLines` → `Max result lines`. */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Label of a property: its schema title, else the humanized name. */
export const propertyLabel = (property: Property, root: unknown) => {
  const title = resolve(property.schema, root).title
  return typeof title === 'string' ? title : humanize(property.name)
}

/** Description from the schema, if any. */
export const describedAs = (schema: unknown, root: unknown) =>
  str(resolve(schema, root).description)

/** Whether the form can say more than a raw JSON field would. */
export const hasForm = (schema: unknown) => describeField(schema, schema).kind !== 'any'
