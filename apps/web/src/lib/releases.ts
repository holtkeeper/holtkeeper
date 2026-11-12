import type {
  GateResult,
  Issue,
  IssueCategory,
  PersonView,
  ReleaseBump,
  ReleaseEdits,
  ReleaseEntry,
  ReleasePlan,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'

/** Tone of a tracker issue by where it stands. */
export const issueTones: Record<IssueCategory, StatusTone> = {
  todo: 'default',
  doing: 'info',
  done: 'success',
}

export const bumpTones: Record<ReleaseBump, StatusTone> = {
  major: 'danger',
  minor: 'accent',
  patch: 'default',
  none: 'default',
}

const sectionOrder: readonly ReleaseEntry['section'][] = [
  'breaking',
  'features',
  'fixes',
  'performance',
  'refactoring',
  'reverts',
  'docs',
  'tests',
  'build',
  'chores',
  'other',
]

const sectionTitles: Record<ReleaseEntry['section'], string> = {
  breaking: 'Breaking changes',
  features: 'Features',
  fixes: 'Fixes',
  performance: 'Performance',
  refactoring: 'Refactoring',
  reverts: 'Reverts',
  docs: 'Docs',
  tests: 'Tests',
  build: 'Build & CI',
  chores: 'Chores',
  other: 'Other',
}

/** Changelog entries grouped by type. */
export interface EntryGroups {
  /** Included entries by section, breaking changes first, empty sections left out. */
  groups: { id: ReleaseEntry['section']; title: string; entries: ReleaseEntry[] }[]
  /** Entries a rule, a revert or a person left out, in their original order. */
  leftOut: ReleaseEntry[]
}

/** Included entries grouped by section in changelog order, and the ones left out. */
export function entryGroups(entries: readonly ReleaseEntry[]): EntryGroups {
  const included = Map.groupBy(
    entries.filter((entry) => entry.included),
    (entry) => entry.section,
  )
  return {
    groups: sectionOrder.flatMap((id) => {
      const list = included.get(id)
      return list ? [{ id, title: sectionTitles[id], entries: list }] : []
    }),
    leftOut: entries.filter((entry) => !entry.included),
  }
}

/** A tracker key of the next version with the entries that name it. */
export interface PlanTask {
  key: string
  /** Entry texts naming the key, at most five. */
  titles: string[]
  commits: number
  /** The tracker's issue, when one is connected and knows the key. */
  issue?: Issue
  url?: string
}

/**
 * Tasks of a plan: ticket keys of its included entries, the most worked-on first, with the
 * tracker's issue (and its page as `url`) where `issues` has one.
 */
export function planTasks(
  entries: readonly ReleaseEntry[],
  issues: Readonly<Record<string, Issue>> = {},
): PlanTask[] {
  const tasks = new Map<string, PlanTask>()
  for (const entry of entries) {
    if (!entry.included) continue
    for (const key of entry.tickets) {
      const issue = issues[key]
      const task = tasks.get(key) ?? {
        key,
        titles: [],
        commits: 0,
        ...(issue ? { issue, ...(issue.url ? { url: issue.url } : {}) } : {}),
      }
      task.commits += entry.commits.length
      if (task.titles.length < 5 && !task.titles.includes(entry.text)) task.titles.push(entry.text)
      tasks.set(key, task)
    }
  }
  return [...tasks.values()].toSorted((a, b) => b.commits - a.commits)
}

const without = (list: readonly string[] | undefined, id: string) =>
  (list ?? []).filter((item) => item !== id)

/**
 * Edits after a person includes or leaves out an entry: leaving out records the id in
 * `excluded`; including undoes that, and also overrides a rule or revert that left it out.
 */
export function toggleEntry(
  edits: ReleaseEdits,
  entry: ReleaseEntry,
  include: boolean,
): ReleaseEdits {
  const excluded = without(edits.excluded, entry.id)
  const included = without(edits.included, entry.id)
  if (include) {
    const override = entry.excludedBy === 'rule' || entry.excludedBy === 'revert'
    return { ...edits, excluded, included: override ? [...included, entry.id] : included }
  }
  return { ...edits, excluded: [...excluded, entry.id], included }
}

/** Edits with a new text for an entry; the original text drops the override. */
export function renameEntry(edits: ReleaseEdits, entry: ReleaseEntry, text: string): ReleaseEdits {
  const texts = { ...edits.texts }
  const trimmed = text.trim()
  if (!trimmed || trimmed === entry.title) delete texts[entry.id]
  else texts[entry.id] = trimmed
  return { ...edits, texts }
}

/** A plan with `edits` applied to its entries locally, before the server recomputes it. */
export function previewEdits(plan: ReleasePlan, edits: ReleaseEdits): ReleasePlan {
  const entries = plan.entries.map((entry) => {
    const byPerson = edits.excluded?.includes(entry.id) ?? false
    const restored = edits.included?.includes(entry.id) ?? false
    const automatic = entry.excludedBy === 'rule' || entry.excludedBy === 'revert'
    const excludedBy = byPerson ? 'person' : automatic && !restored ? entry.excludedBy : undefined
    const { excludedBy: _, ...rest } = entry
    return {
      ...rest,
      text: edits.texts?.[entry.id] ?? entry.title,
      included: excludedBy === undefined,
      ...(excludedBy ? { excludedBy } : {}),
    }
  })
  return { ...plan, entries, edits }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** The version after `current` for each bump, for a picker; empty for non-semantic versions. */
export function bumpChoices(current: string | undefined): Partial<Record<ReleaseBump, string>> {
  if (!current) return {}
  const match = SEMVER.exec(current)
  if (!match) return {}
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: match[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`,
  }
}

/**
 * Gates that fail: `hard` ones nobody may override, `soft` failing `block` gates a person may
 * override, and `warn` ones that never stop a step.
 */
export function failingGates(gates: readonly GateResult[]) {
  const failing = gates.filter((gate) => !gate.ok)
  const hard = failing.filter((gate) => gate.id === 'empty' || gate.id === 'tag-exists')
  return {
    hard,
    soft: failing.filter((gate) => gate.severity === 'block' && !hard.includes(gate)),
    warn: failing.filter((gate) => gate.severity === 'warn'),
  }
}

/** "12 commits", "300+ commits". */
export const countLabel = (count: number, capped: boolean, word = 'commit') =>
  `${count}${capped ? '+' : ''} ${word}${count === 1 && !capped ? '' : 's'}`

const channelLabels: Readonly<Record<string, string>> = {
  ui: 'in the panel',
  api: 'through the API',
  forge: 'on the forge',
  web: 'in the panel chat',
  mcp: 'through MCP',
}

/** Where a release step was run, e.g. `in the panel`; unknown chat surfaces show their id. */
export const channelLabel = (channel: string | undefined): string | undefined =>
  channel ? (channelLabels[channel] ?? `in ${channel}`) : undefined

/** The name of who ran a step: the user's current name, the name recorded with it, else the id. */
export const actorName = (
  people: Readonly<Record<string, PersonView>>,
  id: string,
  recorded?: string,
): string => people[id]?.name ?? recorded ?? id
