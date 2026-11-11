import type { Scope } from '@holtkeeper/api'

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

interface GlobSetsValue {
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

/** Merge request events a policy can react to. */
export const MERGE_REQUEST_EVENTS = [
  'open',
  'update',
  'reopen',
  'label',
  'merge',
  'approve',
  'command',
] as const

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
const serializePolicies = (policies: readonly PolicyValue[]): PolicyValue[] =>
  policies.map((policy) => ({ ...policy, when: cleanCondition(policy.when) }))

/**
 * Stored policies with `policy` saved: it replaces the one with id `previousId` (its own id when
 * absent) in place, or is appended when there is none. The result is ready to store.
 */
export function withPolicy(
  stored: unknown,
  policy: PolicyValue,
  previousId: string = policy.id,
): PolicyValue[] {
  const policies = normalizePolicies(stored)
  const index = policies.findIndex((candidate) => candidate.id === previousId)
  const next = index < 0 ? [...policies, policy] : policies.with(index, policy)
  return serializePolicies(next)
}

/** Stored policies without the one with id `id`, ready to store. */
export const withoutPolicy = (stored: unknown, id: string): PolicyValue[] =>
  serializePolicies(normalizePolicies(stored).filter((policy) => policy.id !== id))

/**
 * The policies entry a new policy of a team goes to: the one scoped to exactly that group (every
 * repository when `group` is absent), or `undefined` when a new entry is needed.
 */
export function policiesEntryFor<E extends { key: string; scope: Scope }>(
  entries: readonly E[],
  key: string,
  group: string | undefined,
): E | undefined {
  return entries.find(
    (entry) =>
      entry.key === key &&
      (group === undefined
        ? entry.scope.all === true
        : !entry.scope.all &&
          !entry.scope.repos?.length &&
          entry.scope.groups?.length === 1 &&
          entry.scope.groups[0] === group),
  )
}
