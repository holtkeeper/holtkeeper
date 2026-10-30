import { type JsonSchema, initialValue, resolve } from './schema-form.ts'

/** A part of a tracker: a source, rule or output config, keyed by `kind`. */
export interface TrackerPart {
  kind: string
  id?: string
  [option: string]: unknown
}

export interface TrackerValue {
  id: string
  name: string
  entity: { label: string; key: { normalize: string[] } }
  sources: TrackerPart[]
  rules: TrackerPart[]
  outputs: TrackerPart[]
}

export type PartList = 'sources' | 'rules' | 'outputs'

export const PART_LISTS: readonly PartList[] = ['sources', 'rules', 'outputs']

/** What each kind of part does, for its block header. */
export const PART_HINTS: Record<string, string> = {
  files: 'Reads files in repositories and extracts entity keys from them.',
  document: 'Reads a document page, e.g. a Confluence table.',
  unused: 'Defined but never used.',
  undefined: 'Used, configured or documented without a definition.',
  'stale-config': 'Configured but no longer defined.',
  undocumented: 'Defined but missing from the documentation.',
  'documented-missing': 'Documented but not defined.',
  'attribute-mismatch': 'An attribute differs between two roles, e.g. defaults per environment.',
  naming: 'Spellings that break a naming pattern.',
  'document-section': 'Writes the overview into a document page or a marked section of it.',
  'repo-file': 'Commits the overview as a file in a repository.',
  notify: 'Sends a summary through the configured notifiers.',
}

const NORMALIZE_STEP = /^(lower|upper|snake|kebab|camel|trim-prefix:.+|trim-suffix:.+)$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const parts = (value: unknown): TrackerPart[] =>
  Array.isArray(value)
    ? value.filter((part): part is TrackerPart => isRecord(part) && typeof part.kind === 'string')
    : []

/** Stored trackers in editor form, defaults filled; anything that is not a tracker is dropped. */
export function normalizeTrackers(value: unknown): TrackerValue[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((tracker) => {
    const entity = isRecord(tracker.entity) ? tracker.entity : {}
    const key = isRecord(entity.key) ? entity.key : {}
    return {
      id: typeof tracker.id === 'string' ? tracker.id : '',
      name: typeof tracker.name === 'string' ? tracker.name : '',
      entity: {
        label: typeof entity.label === 'string' ? entity.label : 'Entity',
        key: { normalize: strings(key.normalize) },
      },
      sources: parts(tracker.sources),
      rules: parts(tracker.rules),
      outputs: parts(tracker.outputs),
    }
  })
}

/** The part variants of a trackers form schema for one list, keyed by their `kind` constant. */
export function partVariants(schema: unknown, list: PartList): Map<string, JsonSchema> {
  const tracker = resolve(resolve(schema, schema).items, schema)
  const properties = isRecord(tracker.properties) ? tracker.properties : {}
  const item = resolve(resolve(properties[list], schema).items, schema)
  const variants = Array.isArray(item.oneOf)
    ? item.oneOf
    : Array.isArray(item.anyOf)
      ? item.anyOf
      : []
  const out = new Map<string, JsonSchema>()
  for (const variant of variants) {
    const resolved = resolve(variant, schema)
    const props = isRecord(resolved.properties) ? resolved.properties : {}
    const kind = isRecord(props.kind) ? props.kind.const : undefined
    if (typeof kind === 'string') out.set(kind, resolved)
  }
  return out
}

/** A new part of `kind` with the required fields its schema gives. */
export function newPart(kind: string, variant: JsonSchema | undefined, root: unknown): TrackerPart {
  const initial = variant ? initialValue(variant, root) : undefined
  return { ...(isRecord(initial) ? initial : {}), kind }
}

/** The id a part goes by: its own, else `<kind>-<n>` for sources and outputs and the kind for rules. */
export const partId = (part: TrackerPart, index: number, list: PartList) =>
  part.id ?? (list === 'rules' ? part.kind : `${part.kind}-${index + 1}`)

/**
 * Roles named by the fields of `part` its schema marks `x-role: <mode>`: the value when set, else
 * the schema default. Nested objects are followed.
 */
export function rolesOf(
  part: Record<string, unknown>,
  variant: JsonSchema | undefined,
  root: unknown,
  mode: 'provides' | 'reads',
): string[] {
  if (!variant) return []
  const properties = isRecord(variant.properties) ? variant.properties : {}
  const out: string[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const field = resolve(raw, root)
    const value = part[name] ?? field.default
    if (field['x-role'] === mode) {
      if (typeof value === 'string') out.push(value)
      else out.push(...strings(value))
    } else if (field.type === 'object' || isRecord(field.properties)) {
      out.push(...rolesOf(isRecord(value) ? value : {}, field, root, mode))
    }
  }
  return [...new Set(out)]
}

export interface TrackerLinks {
  sources: { id: string; kind: string; role: string[] }[]
  rules: { id: string; kind: string; reads: string[]; missing: string[] }[]
  outputs: { id: string; kind: string }[]
  /** Source ids whose role no rule reads. */
  unread: string[]
}

/** Who feeds whom in a tracker: source roles, the roles each rule reads, the outputs. */
export function trackerLinks(
  tracker: TrackerValue,
  variants: Record<PartList, Map<string, JsonSchema>>,
  root: unknown,
): TrackerLinks {
  const sources = tracker.sources.map((part, i) => ({
    id: partId(part, i, 'sources'),
    kind: part.kind,
    role: rolesOf(part, variants.sources.get(part.kind), root, 'provides'),
  }))
  const provided = new Set(sources.flatMap((source) => source.role))
  const rules = tracker.rules.map((part, i) => {
    const reads = rolesOf(part, variants.rules.get(part.kind), root, 'reads')
    return {
      id: partId(part, i, 'rules'),
      kind: part.kind,
      reads,
      missing: reads.filter((role) => !provided.has(role)),
    }
  })
  const read = new Set(rules.flatMap((rule) => rule.reads))
  return {
    sources,
    rules,
    outputs: tracker.outputs.map((part, i) => ({
      id: partId(part, i, 'outputs'),
      kind: part.kind,
    })),
    unread: rules.length
      ? sources.filter((s) => s.role.every((role) => !read.has(role))).map((s) => s.id)
      : [],
  }
}

/** Problems that would make the server reject a tracker, by tracker index. */
export function trackerProblems(trackers: readonly TrackerValue[]): Map<number, string[]> {
  const problems = new Map<number, string[]>()
  const add = (index: number, problem: string) =>
    problems.set(index, [...(problems.get(index) ?? []), problem])
  const seen = new Set<string>()
  trackers.forEach((tracker, index) => {
    if (!ID_PATTERN.test(tracker.id))
      add(
        index,
        'Id starts with a letter or digit and uses letters, digits, dots, dashes, underscores',
      )
    else if (seen.has(tracker.id)) add(index, `Id ${tracker.id} is used twice`)
    seen.add(tracker.id)
    if (!tracker.name.trim()) add(index, 'Give the tracker a name')
    if (!tracker.entity.label.trim()) add(index, 'Name what one entity is called')
    if (tracker.sources.length === 0) add(index, 'Add at least one source')
    const bad = tracker.entity.key.normalize.filter((step) => !NORMALIZE_STEP.test(step))
    if (bad.length) add(index, `Unknown normalize step ${bad.join(', ')}`)
    for (const list of PART_LISTS) {
      const ids = tracker[list].map((part, i) => partId(part, i, list))
      const repeated = ids.find((id, i) => ids.indexOf(id) !== i)
      if (repeated) add(index, `Two ${list} share the id ${repeated}; give them distinct ids`)
    }
  })
  return problems
}

/** A new tracker whose id does not clash with `taken`. */
export function newTracker(taken: readonly string[]): TrackerValue {
  let n = taken.length + 1
  while (taken.includes(`tracker-${n}`)) n++
  return {
    id: `tracker-${n}`,
    name: 'New tracker',
    entity: { label: 'Entity', key: { normalize: [] } },
    sources: [],
    rules: [],
    outputs: [],
  }
}

/** Whether `step` is a valid key normalization step. */
export const isNormalizeStep = (step: string) => NORMALIZE_STEP.test(step)
