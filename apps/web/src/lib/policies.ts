import { type JsonSchema, initialValue, resolve } from './schema-form.ts'

/** A merge request condition as the editor holds it: lists already normalized. */
export interface ConditionValue {
  event?: string[]
  sourceBranch?: string[]
  targetBranch?: string[]
  author?: { users?: string[]; bot?: boolean }
  labels?: GlobSetsValue
  labelAdded?: string[]
  title?: string
  draft?: boolean
  command?: string[]
  changedPaths?: GlobSetsValue
  size?: { maxLines?: number; maxFiles?: number; minLines?: number; minFiles?: number }
  pipeline?: string[]
  all?: ConditionValue[]
  any?: ConditionValue[]
  not?: ConditionValue
}

export interface GlobSetsValue {
  all?: string[]
  any?: string[]
  none?: string[]
}

export interface ActionValue {
  type: string
  [option: string]: unknown
}

export interface PolicyValue {
  id: string
  name: string
  enabled: boolean
  when: ConditionValue
  actions: ActionValue[]
  stop?: boolean
  skipAnalyzers?: '*' | string[]
  /** A policy's own scope, kept as stored; the editor does not change it. */
  scope?: unknown
}

/** Leaf condition fields, in the order the editor offers them. */
export type ConditionField = Exclude<keyof ConditionValue, 'all' | 'any' | 'not'>

export const MERGE_REQUEST_EVENTS = [
  'open',
  'update',
  'reopen',
  'label',
  'merge',
  'approve',
  'command',
] as const

export const PIPELINE_STATES = ['success', 'failed', 'running', 'none'] as const

/** What each leaf condition is called and how it is explained. */
export const CONDITION_FIELDS: Record<ConditionField, { label: string; hint: string }> = {
  event: { label: 'Event', hint: 'The webhook event is one of these.' },
  targetBranch: { label: 'Target branch', hint: 'Globs, e.g. main or release/*.' },
  sourceBranch: { label: 'Source branch', hint: 'Globs, e.g. renovate/*.' },
  author: { label: 'Author', hint: 'Usernames or globs; optionally only bots or only people.' },
  labels: { label: 'Labels', hint: 'Exact label names the merge request has.' },
  labelAdded: { label: 'Label added', hint: 'This event added one of these labels.' },
  title: { label: 'Title', hint: 'Regular expression: pattern or /pattern/flags.' },
  draft: { label: 'Draft', hint: 'Whether the merge request is a draft.' },
  command: { label: 'Command', hint: 'A /command in a comment, without the slash.' },
  changedPaths: { label: 'Changed paths', hint: 'Globs over changed files. Loads the diff.' },
  size: { label: 'Size', hint: 'Changed lines and files. Loads the diff.' },
  pipeline: { label: 'Pipeline', hint: 'State of the latest pipeline for the head commit.' },
}

export const CONDITION_FIELD_ORDER: readonly ConditionField[] = [
  'event',
  'targetBranch',
  'sourceBranch',
  'author',
  'labels',
  'labelAdded',
  'title',
  'draft',
  'command',
  'changedPaths',
  'size',
  'pipeline',
]

/** Whether `name` is a leaf condition field. */
export const isConditionField = (name: string): name is ConditionField =>
  (CONDITION_FIELD_ORDER as readonly string[]).includes(name)

/** What each built-in action does, for its block header. */
export const ACTION_HINTS: Record<string, string> = {
  approve: 'Approve the merge request.',
  merge: 'Merge now, or when the pipeline succeeds.',
  label: 'Add or remove labels.',
  comment: 'Post a comment; supports placeholders such as {author}.',
  assignReviewers: 'Request reviews from these users.',
  draft: 'Mark as draft or as ready.',
  close: 'Close the merge request.',
  enqueue: 'Run an analyzer on the merge request.',
  webhook: 'POST the event to a URL.',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const list = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}

const globSets = (value: unknown): GlobSetsValue | undefined => {
  if (!isRecord(value)) return undefined
  const out: GlobSetsValue = {}
  for (const key of ['all', 'any', 'none'] as const) {
    const items = list(value[key])
    if (items) out[key] = items
  }
  return out
}

/** A stored condition with single values turned into lists (`targetBranch: main` → `['main']`). */
function normalizeCondition(value: unknown): ConditionValue {
  if (!isRecord(value)) return {}
  const out: ConditionValue = {}
  for (const key of [
    'event',
    'sourceBranch',
    'targetBranch',
    'labelAdded',
    'command',
    'pipeline',
  ] as const) {
    const items = list(value[key])
    if (items) out[key] = items
  }
  if (typeof value.title === 'string') out.title = value.title
  if (typeof value.draft === 'boolean') out.draft = value.draft
  const author = value.author
  if (typeof author === 'string' || Array.isArray(author))
    out.author = { users: list(author) ?? [] }
  else if (isRecord(author)) {
    const users = list(author.users)
    out.author = {
      ...(users ? { users } : {}),
      ...(typeof author.bot === 'boolean' ? { bot: author.bot } : {}),
    }
  }
  const labels = globSets(value.labels)
  if (labels) out.labels = labels
  const paths = globSets(value.changedPaths)
  if (paths) out.changedPaths = paths
  if (isRecord(value.size)) {
    const size: NonNullable<ConditionValue['size']> = {}
    for (const key of ['maxLines', 'maxFiles', 'minLines', 'minFiles'] as const) {
      const n = value.size[key]
      if (typeof n === 'number') size[key] = n
    }
    out.size = size
  }
  for (const key of ['all', 'any'] as const) {
    const nested = value[key]
    if (Array.isArray(nested)) out[key] = nested.map(normalizeCondition)
  }
  if (value.not !== undefined) out.not = normalizeCondition(value.not)
  return out
}

/** Stored policies in editor form; anything that is not a policy object is dropped. */
export function normalizePolicies(value: unknown): PolicyValue[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((policy) => {
    const skip = policy.skipAnalyzers
    return {
      id: typeof policy.id === 'string' ? policy.id : '',
      name: typeof policy.name === 'string' ? policy.name : '',
      enabled: policy.enabled !== false,
      when: normalizeCondition(policy.when),
      actions: Array.isArray(policy.actions)
        ? policy.actions.filter(
            (action): action is ActionValue => isRecord(action) && typeof action.type === 'string',
          )
        : [],
      ...(policy.stop === true ? { stop: true } : {}),
      ...(skip === '*' ? { skipAnalyzers: '*' as const } : {}),
      ...(Array.isArray(skip) ? { skipAnalyzers: list(skip) ?? [] } : {}),
      ...(isRecord(policy.scope) ? { scope: policy.scope } : {}),
    }
  })
}

/** A starting value for a newly added leaf condition. */
export function emptyField(field: ConditionField): ConditionValue[ConditionField] {
  switch (field) {
    case 'title':
      return ''
    case 'draft':
      return false
    case 'author':
      return { users: [] }
    case 'labels':
    case 'changedPaths':
      return { any: [] }
    case 'size':
      return { maxLines: 200 }
    case 'event':
      return ['open', 'update']
    default:
      return []
  }
}

/** A new policy whose id does not clash with `taken`. */
export function newPolicy(taken: readonly string[]): PolicyValue {
  let n = taken.length + 1
  while (taken.includes(`policy-${n}`)) n++
  return {
    id: `policy-${n}`,
    name: 'New policy',
    enabled: true,
    when: { event: ['open', 'update'] },
    actions: [],
  }
}

/** The action variants of a policies form schema, keyed by their `type` constant. */
export function actionVariants(schema: unknown): Map<string, JsonSchema> {
  const root = resolve(schema, schema)
  const policy = resolve(root.items, schema)
  const properties = isRecord(policy.properties) ? policy.properties : {}
  const actions = resolve(properties.actions, schema)
  const item = resolve(actions.items, schema)
  const variants = Array.isArray(item.anyOf)
    ? item.anyOf
    : Array.isArray(item.oneOf)
      ? item.oneOf
      : []
  const out = new Map<string, JsonSchema>()
  for (const variant of variants) {
    const resolved = resolve(variant, schema)
    const props = isRecord(resolved.properties) ? resolved.properties : {}
    const type = isRecord(props.type) ? props.type.const : undefined
    if (typeof type === 'string') out.set(type, resolved)
  }
  return out
}

/** A new action of `type` with the required options its schema gives. */
export function newAction(
  type: string,
  variant: JsonSchema | undefined,
  root: unknown,
): ActionValue {
  const initial = variant ? initialValue(variant, root) : undefined
  return { ...(isRecord(initial) ? initial : {}), type }
}

const joinOr = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`

function describeGlobs(name: string, sets: GlobSetsValue): string[] {
  const out: string[] = []
  if (sets.all?.length) out.push(`${name} all match ${joinOr(sets.all)}`)
  if (sets.any?.length) out.push(`${name} include ${joinOr(sets.any)}`)
  if (sets.none?.length) out.push(`no ${name} match ${joinOr(sets.none)}`)
  return out
}

/** One clause per set field of a condition, in plain words. */
export function describeCondition(condition: ConditionValue): string[] {
  const out: string[] = []
  if (condition.event?.length) out.push(`event is ${joinOr(condition.event)}`)
  if (condition.targetBranch?.length) out.push(`target is ${joinOr(condition.targetBranch)}`)
  if (condition.sourceBranch?.length) out.push(`source is ${joinOr(condition.sourceBranch)}`)
  if (condition.author) {
    const who = condition.author.users?.length ? joinOr(condition.author.users) : 'anyone'
    const kind =
      condition.author.bot === true ? ' (bot)' : condition.author.bot === false ? ' (person)' : ''
    out.push(`author is ${who}${kind}`)
  }
  if (condition.labels) out.push(...describeGlobs('labels', condition.labels))
  if (condition.labelAdded?.length) out.push(`label ${joinOr(condition.labelAdded)} added`)
  if (condition.title) out.push(`title matches ${condition.title}`)
  if (condition.draft !== undefined) out.push(condition.draft ? 'is a draft' : 'is not a draft')
  if (condition.command?.length) out.push(`command is /${joinOr(condition.command)}`)
  if (condition.changedPaths) out.push(...describeGlobs('changed paths', condition.changedPaths))
  if (condition.size) {
    const { maxLines, maxFiles, minLines, minFiles } = condition.size
    if (maxLines !== undefined) out.push(`at most ${maxLines} lines`)
    if (maxFiles !== undefined) out.push(`at most ${maxFiles} files`)
    if (minLines !== undefined) out.push(`at least ${minLines} lines`)
    if (minFiles !== undefined) out.push(`at least ${minFiles} files`)
  }
  if (condition.pipeline?.length) out.push(`pipeline is ${joinOr(condition.pipeline)}`)
  for (const nested of condition.all ?? []) {
    const inner = describeCondition(nested)
    if (inner.length) out.push(`(${inner.join(' and ')})`)
  }
  if (condition.any?.length) {
    const options = condition.any.map((c) => describeCondition(c).join(' and ') || 'always')
    out.push(`(${options.join(' or ')})`)
  }
  if (condition.not) {
    const inner = describeCondition(condition.not)
    if (inner.length) out.push(`not (${inner.join(' and ')})`)
  }
  return out
}

/** A one-line reading of a policy: `If … → approve, merge`. */
export function summarizePolicy(policy: PolicyValue): string {
  const when = describeCondition(policy.when)
  const then = policy.actions.map((action) => action.type)
  if (policy.skipAnalyzers === '*') then.push('skip all analyzers')
  else if (policy.skipAnalyzers?.length) then.push(`skip ${policy.skipAnalyzers.join(', ')}`)
  return `${when.length ? `If ${when.join(' and ')}` : 'Always'} → ${then.length ? then.join(', ') : 'nothing'}`
}

const ID_PATTERN = /^[\w.-]+$/

/** Problems that would make the server reject the policies, by policy index. */
export function policyProblems(policies: readonly PolicyValue[]): Map<number, string[]> {
  const problems = new Map<number, string[]>()
  const add = (index: number, problem: string) =>
    problems.set(index, [...(problems.get(index) ?? []), problem])
  const seen = new Set<string>()
  policies.forEach((policy, index) => {
    if (!ID_PATTERN.test(policy.id))
      add(index, 'Id may use letters, digits, dots, dashes and underscores')
    else if (seen.has(policy.id)) add(index, `Id ${policy.id} is used twice`)
    seen.add(policy.id)
    if (!policy.name.trim()) add(index, 'Give the policy a name')
    for (const action of policy.actions) {
      if (action.type === 'label' && !(list(action.add)?.length || list(action.remove)?.length))
        add(index, 'A label action needs labels to add or remove')
    }
  })
  return problems
}

const cleanList = (items: string[] | undefined) => (items?.length ? items : undefined)

function cleanGlobs(sets: GlobSetsValue | undefined): GlobSetsValue | undefined {
  if (!sets) return undefined
  const out: GlobSetsValue = {}
  for (const key of ['all', 'any', 'none'] as const) {
    const items = cleanList(sets[key])
    if (items) out[key] = items
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * A condition ready to store: empty lists, blank titles and empty groups dropped, since the server
 * rejects them. An empty `Not` is dropped too: it is unfinished, and stored it would never hold.
 */
export function cleanCondition(condition: ConditionValue): ConditionValue {
  const out: ConditionValue = {}
  for (const key of [
    'event',
    'sourceBranch',
    'targetBranch',
    'labelAdded',
    'command',
    'pipeline',
  ] as const) {
    const items = cleanList(condition[key])
    if (items) out[key] = items
  }
  if (condition.title?.trim()) out.title = condition.title
  if (condition.draft !== undefined) out.draft = condition.draft
  if (condition.author) {
    const users = cleanList(condition.author.users)
    const author = {
      ...(users ? { users } : {}),
      ...(condition.author.bot !== undefined ? { bot: condition.author.bot } : {}),
    }
    if (Object.keys(author).length) out.author = author
  }
  const labels = cleanGlobs(condition.labels)
  if (labels) out.labels = labels
  const paths = cleanGlobs(condition.changedPaths)
  if (paths) out.changedPaths = paths
  if (condition.size && Object.keys(condition.size).length) out.size = condition.size
  for (const key of ['all', 'any'] as const) {
    const nested = condition[key]?.map(cleanCondition)
    if (nested?.length) out[key] = nested
  }
  if (condition.not) {
    const not = cleanCondition(condition.not)
    if (Object.keys(not).length) out.not = not
  }
  return out
}

/** Policies as the setting stores them. */
export const serializePolicies = (policies: readonly PolicyValue[]): PolicyValue[] =>
  policies.map((policy) => ({ ...policy, when: cleanCondition(policy.when) }))
