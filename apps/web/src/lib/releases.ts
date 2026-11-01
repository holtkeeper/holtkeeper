import type {
  DeployStatus,
  GateResult,
  ReleaseBoardRow,
  ReleaseBump,
  ReleaseEdits,
  ReleaseEntry,
  ReleasePlan,
  ReleaseStage,
} from '@holtkeeper/api'

import type { Tone } from '../ui/Chip.tsx'

export const stageLabels: Record<ReleaseStage, string> = {
  'awaiting-version': 'Awaiting version',
  proposed: 'Candidate open',
  candidate: 'Ready to propose',
  released: 'Released',
  idle: 'Nothing to release',
  external: 'Released elsewhere',
}

export const stageTones: Record<ReleaseStage, Tone> = {
  'awaiting-version': 'warning',
  proposed: 'accent',
  candidate: 'accent',
  released: 'success',
  idle: 'default',
  external: 'default',
}

/** Board order: what needs a person first. */
const stageOrder: readonly ReleaseStage[] = [
  'awaiting-version',
  'proposed',
  'candidate',
  'released',
  'idle',
  'external',
]

export const deployLabels: Record<DeployStatus, string> = {
  'no-pipeline': 'No pipeline',
  missing: 'No job',
  waiting: 'Waiting',
  ready: 'Ready',
  pending: 'Pending',
  running: 'Running',
  success: 'Deployed',
  failed: 'Failed',
  canceled: 'Canceled',
  skipped: 'Skipped',
}

export const deployTones: Record<DeployStatus, Tone> = {
  'no-pipeline': 'default',
  missing: 'default',
  waiting: 'default',
  ready: 'accent',
  pending: 'accent',
  running: 'accent',
  success: 'success',
  failed: 'danger',
  canceled: 'warning',
  skipped: 'default',
}

export const bumpTones: Record<ReleaseBump, Tone> = {
  major: 'danger',
  minor: 'accent',
  patch: 'default',
  none: 'default',
}

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

/** Entries by section in the order the server sent them, with section titles. */
export function entrySections(entries: readonly ReleaseEntry[]) {
  const sections: { id: ReleaseEntry['section']; title: string; entries: ReleaseEntry[] }[] = []
  for (const entry of entries) {
    const section = sections.find((candidate) => candidate.id === entry.section)
    if (section) section.entries.push(entry)
    else sections.push({ id: entry.section, title: sectionTitles[entry.section], entries: [entry] })
  }
  return sections
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

/** Gates that fail, split into the ones a person may override and the ones nobody may. */
export function failingGates(gates: readonly GateResult[]) {
  const failing = gates.filter((gate) => !gate.ok)
  const hard = failing.filter((gate) => gate.id === 'empty' || gate.id === 'tag-exists')
  return { failing, hard, soft: failing.filter((gate) => !hard.includes(gate)) }
}

/** "12 commits", "300+ commits". */
export const countLabel = (count: number, capped: boolean, word = 'commit') =>
  `${count}${capped ? '+' : ''} ${word}${count === 1 && !capped ? '' : 's'}`

/** Whether a board row waits for a person: a version, an open candidate or a failed deploy. */
export function needsAttention(row: ReleaseBoardRow): boolean {
  return (
    row.stage === 'awaiting-version' ||
    row.stage === 'proposed' ||
    (row.deploy?.environments.some((env) => env.status === 'failed') ?? false) ||
    row.error !== undefined
  )
}

/** Rows ordered by stage (see `stageOrder`), then by path. */
export const sortRows = (rows: readonly ReleaseBoardRow[]) =>
  rows.toSorted(
    (a, b) =>
      stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage) ||
      a.repo.path.localeCompare(b.repo.path),
  )
