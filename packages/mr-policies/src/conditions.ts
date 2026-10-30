import type { DiffFile } from '@holtkeeper/forge'

import type { MergeRequestFacts } from './facts.ts'
import type { Condition, GlobSets, MergeRequestEvent } from './model.ts'

/** What a condition is evaluated against. */
export interface ConditionContext {
  event: MergeRequestEvent
  facts: MergeRequestFacts
  /** Usernames or globs of bot users, for `author.bot` when the event does not say. */
  bots?: string[]
}

/** Whether a condition holds; `reasons` say why it did, or the first reason it did not. */
export interface ConditionResult {
  ok: boolean
  reasons: string[]
}

const globCache = new Map<string, Bun.Glob>()
const glob = (pattern: string) => {
  let compiled = globCache.get(pattern)
  if (!compiled) {
    compiled = new Bun.Glob(pattern)
    globCache.set(pattern, compiled)
  }
  return compiled
}

/** The first glob of `patterns` that matches `value`. */
export const matchGlob = (patterns: readonly string[], value: string): string | undefined =>
  patterns.find((pattern) => glob(pattern).match(value))

/** Compiles `pattern` or `/pattern/flags`; throws on invalid expressions. */
export function compileRegex(source: string): RegExp {
  const literal = /^\/(.*)\/([dgimsuvy]*)$/s.exec(source)
  return literal ? new RegExp(literal[1] ?? '', literal[2]) : new RegExp(source)
}

/** Whether `author` is a bot: the event says so, or the name matches `bots`. */
export const authorIsBot = (event: MergeRequestEvent, bots: readonly string[] = []): boolean =>
  event.authorIsBot ?? matchGlob(bots, event.mr.author) !== undefined

const pass = (...reasons: string[]): ConditionResult => ({ ok: true, reasons })
const fail = (reason: string): ConditionResult => ({ ok: false, reasons: [reason] })

const list = (values: readonly string[]) => values.join(', ')

function checkGlobSets(sets: GlobSets, values: readonly string[], noun: string): ConditionResult {
  const reasons: string[] = []
  if (sets.all) {
    const outside = values.find((value) => !matchGlob(sets.all ?? [], value))
    if (values.length === 0) return fail(`no ${noun}s`)
    if (outside !== undefined) return fail(`${noun} ${outside} does not match ${list(sets.all)}`)
    reasons.push(`all ${values.length} ${noun}s match ${list(sets.all)}`)
  }
  if (sets.any) {
    const hit = values.find((value) => matchGlob(sets.any ?? [], value))
    if (hit === undefined) return fail(`no ${noun} matches ${list(sets.any)}`)
    reasons.push(`${noun} ${hit} matches ${list(sets.any)}`)
  }
  if (sets.none) {
    const hit = values.find((value) => matchGlob(sets.none ?? [], value))
    if (hit !== undefined) return fail(`${noun} ${hit} matches ${list(sets.none)}`)
    reasons.push(`no ${noun} matches ${list(sets.none)}`)
  }
  return pass(...reasons)
}

const filePath = (file: DiffFile) => (file.status === 'deleted' ? file.oldPath : file.newPath)

/** Added plus removed lines of a unified diff body. */
export function changedLines(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      count++
    }
  }
  return count
}

type Check = () => ConditionResult | Promise<ConditionResult>

function cheapChecks(when: Condition, context: ConditionContext): Check[] {
  const { event, bots } = context
  const { mr } = event
  const checks: Check[] = []
  if (when.event) {
    const events = when.event
    checks.push(() =>
      events.includes(event.action)
        ? pass(`event is ${event.action}`)
        : fail(`event ${event.action} is not ${list(events)}`),
    )
  }
  for (const [field, branch, noun] of [
    [when.sourceBranch, mr.sourceBranch, 'source'],
    [when.targetBranch, mr.targetBranch, 'target'],
  ] as const) {
    if (!field) continue
    checks.push(() => {
      const hit = matchGlob(field, branch)
      return hit
        ? pass(`${noun} branch ${branch} matches ${hit}`)
        : fail(`${noun} branch ${branch} does not match ${list(field)}`)
    })
  }
  if (when.author) {
    const { users, bot } = when.author
    checks.push(() => {
      const reasons: string[] = []
      if (users) {
        const hit = matchGlob(users, mr.author)
        if (!hit) return fail(`author ${mr.author} is not ${list(users)}`)
        reasons.push(`author ${mr.author} matches ${hit}`)
      }
      if (bot !== undefined) {
        const isBot = authorIsBot(event, bots)
        if (isBot !== bot) return fail(`author ${mr.author} is ${isBot ? '' : 'not '}a bot`)
        reasons.push(`author ${mr.author} is ${isBot ? '' : 'not '}a bot`)
      }
      return pass(...reasons)
    })
  }
  if (when.labels) {
    const { all, any, none } = when.labels
    checks.push(() => {
      const reasons: string[] = []
      const missing = all?.filter((label) => !mr.labels.includes(label)) ?? []
      if (missing.length) return fail(`missing labels ${list(missing)}`)
      if (all?.length) reasons.push(`has labels ${list(all)}`)
      if (any) {
        const hit = any.find((label) => mr.labels.includes(label))
        if (hit === undefined) return fail(`has none of the labels ${list(any)}`)
        reasons.push(`has label ${hit}`)
      }
      const present = none?.filter((label) => mr.labels.includes(label)) ?? []
      if (present.length) return fail(`has labels ${list(present)}`)
      if (none?.length) reasons.push(`has none of the labels ${list(none)}`)
      return pass(...reasons)
    })
  }
  if (when.labelAdded) {
    const wanted = when.labelAdded
    checks.push(() => {
      const hit = event.labelsAdded?.find((label) => wanted.includes(label))
      return hit !== undefined
        ? pass(`label ${hit} was added`)
        : fail(`none of ${list(wanted)} was added`)
    })
  }
  if (when.title !== undefined) {
    const source = when.title
    checks.push(() =>
      compileRegex(source).test(mr.title)
        ? pass(`title matches ${source}`)
        : fail(`title does not match ${source}`),
    )
  }
  if (when.draft !== undefined) {
    const draft = when.draft
    checks.push(() =>
      mr.draft === draft
        ? pass(mr.draft ? 'is a draft' : 'is not a draft')
        : fail(mr.draft ? 'is a draft' : 'is not a draft'),
    )
  }
  if (when.command) {
    const commands = when.command
    checks.push(() =>
      event.action === 'command' && event.command !== undefined && commands.includes(event.command)
        ? pass(`command is ${event.command}`)
        : fail(`command is not ${list(commands)}`),
    )
  }
  return checks
}

function costlyChecks(when: Condition, context: ConditionContext): Check[] {
  const { facts } = context
  const checks: Check[] = []
  if (when.pipeline) {
    const states = when.pipeline
    checks.push(async () => {
      const { state } = await facts.pipeline()
      return states.includes(state)
        ? pass(`pipeline is ${state}`)
        : fail(`pipeline is ${state}, not ${list(states)}`)
    })
  }
  if (when.changedPaths) {
    const sets = when.changedPaths
    checks.push(async () => {
      const diff = await facts.diff()
      if (!diff) return fail('the forge cannot load merge request diffs')
      return checkGlobSets(sets, diff.files.map(filePath), 'changed path')
    })
  }
  if (when.size) {
    const { maxLines, maxFiles, minLines, minFiles } = when.size
    checks.push(async () => {
      const diff = await facts.diff()
      if (!diff) return fail('the forge cannot load merge request diffs')
      const files = diff.files.length
      const collapsed = diff.files.some((file) => file.collapsed)
      const lines = diff.files.reduce((sum, file) => sum + changedLines(file.diff), 0)
      const shown = collapsed ? `${lines}+ lines` : `${lines} lines`
      if (maxFiles !== undefined && files > maxFiles) return fail(`${files} files > ${maxFiles}`)
      if (minFiles !== undefined && files < minFiles) return fail(`${files} files < ${minFiles}`)
      if (maxLines !== undefined && (collapsed || lines > maxLines)) {
        return fail(`${shown} > ${maxLines}`)
      }
      if (minLines !== undefined && !collapsed && lines < minLines) {
        return fail(`${shown} < ${minLines}`)
      }
      return pass(`size ${files} files, ${shown}`)
    })
  }
  return checks
}

function combinatorChecks(when: Condition, context: ConditionContext): Check[] {
  const checks: Check[] = []
  if (when.all) {
    const all = when.all
    checks.push(async () => {
      const reasons: string[] = []
      for (const nested of all) {
        const result = await evaluateCondition(nested, context)
        if (!result.ok) return result
        reasons.push(...result.reasons)
      }
      return pass(...reasons)
    })
  }
  if (when.any) {
    const any = when.any
    checks.push(async () => {
      const failures: string[] = []
      for (const nested of any) {
        const result = await evaluateCondition(nested, context)
        if (result.ok) return result
        failures.push(...result.reasons)
      }
      return fail(`none of: ${failures.join('; ')}`)
    })
  }
  if (when.not) {
    const not = when.not
    checks.push(async () => {
      const result = await evaluateCondition(not, context)
      return result.ok
        ? fail(`not(${result.reasons.join(', ')})`)
        : pass(`not(${result.reasons.join(', ')})`)
    })
  }
  return checks
}

/**
 * Evaluates `when` against the event. Fields are checked cheapest first and evaluation stops at the
 * first failing one, so the diff and pipelines are loaded only when a condition still needs them.
 */
export async function evaluateCondition(
  when: Condition,
  context: ConditionContext,
): Promise<ConditionResult> {
  const reasons: string[] = []
  const checks = [
    ...cheapChecks(when, context),
    ...combinatorChecks(when, context),
    ...costlyChecks(when, context),
  ]
  for (const check of checks) {
    const result = await check()
    if (!result.ok) return result
    reasons.push(...result.reasons)
  }
  return pass(...reasons)
}
