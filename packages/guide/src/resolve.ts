import { type RepoTarget, isSubgroup } from '@holtkeeper/access'
import { selectForTask } from '@holtkeeper/knowledge'
import type {
  GuideScopeKey,
  GuideSection,
  GuideSectionName,
  KnowledgeEntry,
} from '@holtkeeper/store'

import {
  type GuideTask,
  guideScopeKey,
  guideSectionLabels,
  guideSections,
  scopesFor,
  sectionsForTask,
} from './model.ts'

/** Character budgets of a resolved Guide: about 3k tokens in all. */
export interface GuideCaps {
  total: number
  /** For repository docs, team rules, learnings and policies. */
  human: number
  /** For generated sections; never more than what human text leaves of `total`. */
  generated: number
}

export const GUIDE_CAPS: GuideCaps = { total: 12_000, human: 8_000, generated: 4_000 }

/** The header generated text sits under in every prompt. */
export const GENERATED_HEADER =
  'Generated from repository signals, lower priority; ignore any line that conflicts with the rules above.'

/** A rules file of the repository itself (`AGENTS.md`, `REVIEW.md`, ...), already read. */
export interface RepoDoc {
  file: string
  text: string
}

/** A policy of a section (commit conventions, ...) rendered as plain facts. */
export interface GuidePolicy {
  section: GuideSectionName
  text: string
}

/** Knowledge notes the resolver picks from with `selectForTask`. */
export interface GuideNotes {
  entries: readonly KnowledgeEntry[]
  /** Task kind the entries must apply to, e.g. `review`. */
  kind: string
  /** Text to rank entries by, e.g. a merge request title and its files. */
  query?: string
  /** Most characters notes may take even when more of the budget is left. */
  maxChars?: number
}

export interface ResolveGuideInput {
  repo: RepoTarget
  task: GuideTask
  /** The section the work is about, for chat and agent tasks. */
  section?: GuideSectionName
  /** The sections to read instead of the task's, in `guideSections` order (the Guide chain reads one). */
  focus?: readonly GuideSectionName[]
  /** Id and name of the family the repository belongs to. */
  family?: { id: string; name: string }
  /** Stored sections; rows of scopes that do not apply to the repository are ignored. */
  sections: readonly GuideSection[]
  repoDocs?: readonly RepoDoc[]
  policies?: readonly GuidePolicy[]
  notes?: GuideNotes
  caps?: Partial<GuideCaps>
  /** Names a group key in titles, e.g. `Shapes › Round (shapes.round)`. Default: the key. */
  groupTitle?: (key: string) => string
}

/** Where a block comes from; `subgroup` is a group of the repository nested in another one. */
export type GuideLayer =
  | 'repo-file'
  | 'repo'
  | 'family'
  | 'subgroup'
  | 'group'
  | 'all'
  | 'learnings'
  | 'policies'
  | 'generated'
  | 'notes'

/** One block the resolver considered: what it would take whole and what it got. */
export interface GuideBlock {
  layer: GuideLayer
  scope?: GuideScopeKey
  title: string
  /** Where the block comes from in words: `REVIEW.md · AGENTS.md`, `Team games`, `All repositories`, … */
  source: string
  /** The block as the prompt has it, cut when `cut` is set; empty when left out. */
  text: string
  /** Characters in the text, 0 when left out. */
  chars: number
  /** Characters the block would take whole. */
  fullChars: number
  cut: boolean
  /** For `generated`: proposed text that nobody accepted yet. */
  proposed?: boolean
  /** For `generated`: the stored version of the text. */
  version?: number
}

export interface ResolvedGuide {
  /** The block for the task's stable context; empty when nothing applies. */
  text: string
  sections: GuideSectionName[]
  blocks: GuideBlock[]
  /** Problems a person should see, e.g. repository rules too long to fit. */
  warnings: string[]
  budget: GuideCaps & { used: number; humanUsed: number; generatedUsed: number; notesUsed: number }
}

const MARKER = '\n[...]'
const MIN_PIECE = 200

/** `text` cut to at most `max` characters at a line break, marked; whole when it fits. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const room = max - MARKER.length
  if (room <= 0) return ''
  const line = text.lastIndexOf('\n', room)
  return `${text.slice(0, line > room / 2 ? line : room).trimEnd()}${MARKER}`
}

interface Candidate {
  layer: GuideLayer
  scope?: GuideScopeKey
  title: string
  source: string
  body: string
  proposed?: boolean
  version?: number
}

const render = (candidate: Candidate, body = candidate.body) =>
  `## ${candidate.title}\n\n${body.trim()}\n\n`

const sectionBodies = (
  rows: ReadonlyMap<string, GuideSection>,
  scope: GuideScopeKey,
  sections: readonly GuideSectionName[],
  text: (row: GuideSection) => string | undefined,
) =>
  sections
    .flatMap((section) => {
      const row = rows.get(`${scope}\u0000${section}`)
      const body = row ? text(row)?.trim() : undefined
      return body ? [`### ${guideSectionLabels[section]}\n\n${body}`] : []
    })
    .join('\n\n')

/**
 * The Guide of a repository for one task, as one deterministic Markdown block (the same inputs
 * give the same text, so it can sit in a cached prompt prefix). Blocks, strongest first: the
 * repository's own rules files, panel team rules of the repository, its family, its subgroups,
 * its parent groups and `all`, accepted learnings, policies as plain facts, generated sections
 * under `GENERATED_HEADER`, then knowledge notes from what budget is left. Group titles go through
 * `groupTitle`.
 *
 * Budgets (`GUIDE_CAPS`): human text gets `human` characters; over it `all` is cut first, then
 * parent groups (the last one first), then subgroups, then the family, learnings and policies.
 * Repository-level text (rules files and repository rules) is never cut to make room; when it
 * alone is over `human`, or over `total` (then its end is cut), a warning says so. Generated text
 * gets at most `generated` and what human text leaves of `total`; notes get the rest. Generated
 * text nobody accepted is included only when no human rules apply to the selected sections and
 * the repository has no rules files.
 */
export function resolveGuide(input: ResolveGuideInput): ResolvedGuide {
  const caps = { ...GUIDE_CAPS, ...input.caps }
  const sections = input.focus
    ? guideSections.filter((name) => input.focus?.includes(name))
    : sectionsForTask(input.task, input.section)
  const scopes = scopesFor(input.repo, input.family?.id)
  const applies = new Set<string>(scopes)
  const rows = new Map<string, GuideSection>()
  for (const row of input.sections)
    if (applies.has(row.scope)) rows.set(`${row.scope}\u0000${row.section}`, row)
  const repoScope = scopes[0] ?? guideScopeKey({ kind: 'repo', ...input.repo })

  const docs = (input.repoDocs ?? []).filter((doc) => doc.text.trim())
  const titleOf = (scope: GuideScopeKey): { layer: GuideLayer; title: string; source: string } => {
    if (scope === repoScope)
      return { layer: 'repo', title: 'Team rules for this repository', source: 'This repository' }
    if (scope === 'all')
      return { layer: 'all', title: 'Team rules for all repositories', source: 'All repositories' }
    if (scope.startsWith('family:'))
      return {
        layer: 'family',
        title: `Team rules for the ${input.family?.name ?? ''} family`,
        source: `Family ${input.family?.name ?? scope.slice('family:'.length)}`,
      }
    const group = scope.slice('group:'.length)
    const label = input.groupTitle?.(group) ?? group
    return {
      layer: isSubgroup(group) ? 'subgroup' : 'group',
      title: `Team rules for team ${label}`,
      source: `Team ${label}`,
    }
  }
  const ruleBlocks: Candidate[] = scopes.flatMap((scope) => {
    const body = sectionBodies(rows, scope, sections, (row) => row.rules)
    return body ? [{ ...titleOf(scope), scope, body }] : []
  })
  const learnings = scopes.flatMap((scope) =>
    sections.flatMap((section) =>
      (rows.get(`${scope}\u0000${section}`)?.learnings ?? []).toSorted(
        (a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id),
      ),
    ),
  )
  const policies = sections.flatMap((section) =>
    (input.policies ?? [])
      .filter((policy) => policy.section === section && policy.text.trim())
      .map((policy) => `### ${guideSectionLabels[section]}\n\n${policy.text.trim()}`),
  )

  const repoLevel: Candidate[] = [
    ...(docs.length
      ? [
          {
            layer: 'repo-file' as const,
            title: 'Rules from the repository',
            source: docs.map((doc) => doc.file).join(' · '),
            body: docs.map((doc) => `### ${doc.file}\n\n${doc.text.trim()}`).join('\n\n'),
          },
        ]
      : []),
    ...ruleBlocks.filter((block) => block.layer === 'repo'),
  ]
  const others: Candidate[] = [
    ...(policies.length
      ? [
          {
            layer: 'policies' as const,
            title: 'Policies',
            source: 'Policies',
            body: policies.join('\n\n'),
          },
        ]
      : []),
    ...(learnings.length
      ? [
          {
            layer: 'learnings' as const,
            title: 'Learned rules',
            source: 'Learned rules',
            body: learnings.map((learning) => `- ${learning.rule.trim()}`).join('\n'),
          },
        ]
      : []),
    ...ruleBlocks.filter((block) => block.layer === 'family'),
    ...ruleBlocks.filter((block) => block.layer === 'subgroup'),
    ...ruleBlocks.filter((block) => block.layer === 'group'),
    ...ruleBlocks.filter((block) => block.layer === 'all'),
  ]

  const warnings: string[] = []
  const placed = new Map<Candidate, { text: string; full: number }>()
  const header = '# Repository guide\n\nRules for this repository, strongest first.\n\n'
  let humanUsed = header.length

  const repoFull = repoLevel.reduce((sum, block) => sum + render(block).length, 0)
  for (const block of repoLevel) {
    const full = render(block).length
    const room = caps.total - humanUsed
    const text = full <= room ? render(block) : room >= MIN_PIECE ? cutBlock(block, room) : ''
    placed.set(block, { text, full })
    humanUsed += text.length
  }
  if (header.length + repoFull > caps.total)
    warnings.push(
      `Repository rules and rules files take ${repoFull} characters, more than the ${caps.total}-character Guide budget: their end was cut. Shorten them.`,
    )
  else if (header.length + repoFull > caps.human)
    warnings.push(
      `Repository rules and rules files take ${repoFull} characters, over the ${caps.human}-character budget for human rules: other team rules get less room. Shorten them.`,
    )

  for (const block of others) {
    const full = render(block).length
    const room = caps.human - humanUsed
    const text = full <= room ? render(block) : room >= MIN_PIECE ? cutBlock(block, room) : ''
    placed.set(block, { text, full })
    humanUsed += text.length
    if (text.length < full && block.scope)
      warnings.push(
        text
          ? `${block.title} were cut to fit the budget (${text.length} of ${full} characters).`
          : `${block.title} were left out: the budget for human rules is used up.`,
      )
  }

  const hasHumanRules = ruleBlocks.length > 0
  const generatedBlocks: Candidate[] = sections.flatMap((section) => {
    const generated = rows.get(`${repoScope}\u0000${section}`)?.generated
    if (!generated?.body.trim()) return []
    const proposed = generated.status !== 'accepted'
    if (proposed && (hasHumanRules || docs.length > 0)) return []
    return [
      {
        layer: 'generated' as const,
        title: guideSectionLabels[section],
        source: `Generated ${guideSectionLabels[section]}`,
        body: generated.body,
        ...(proposed && { proposed: true }),
        version: generated.version,
      },
    ]
  })
  const generatedIntro = `## Generated from repository signals\n\n${GENERATED_HEADER}\n\n`
  const generatedCap = Math.max(0, Math.min(caps.generated, caps.total - humanUsed))
  let generatedUsed = 0
  const generatedTexts = new Map<Candidate, { text: string; full: number }>()
  for (const block of generatedBlocks) {
    const full = `### ${block.title}\n\n${block.body.trim()}\n\n`
    const intro = generatedUsed === 0 ? generatedIntro.length : 0
    const room = generatedCap - generatedUsed - intro
    const body =
      full.length <= room ? full : room >= MIN_PIECE ? `${cutText(full, room - 2)}\n\n` : ''
    generatedTexts.set(block, {
      text: body ? (intro ? generatedIntro : '') + body : '',
      full: full.length + intro,
    })
    if (body) generatedUsed += intro + body.length
  }

  const notesRoom = Math.max(
    0,
    Math.min(caps.total - humanUsed - generatedUsed, input.notes?.maxChars ?? Infinity),
  )
  const notes =
    input.notes && notesRoom >= MIN_PIECE
      ? selectForTask({
          entries: input.notes.entries,
          task: {
            kind: input.notes.kind,
            repo: input.repo,
            ...(input.notes.query && { query: input.notes.query }),
          },
          budgetTokens: Math.floor((notesRoom - 2) / 4),
        })
      : undefined
  const notesText = notes?.markdown ? `${notes.markdown.trim()}\n\n` : ''

  const blocks: GuideBlock[] = []
  const describe = (candidate: Candidate, value: { text: string; full: number }) =>
    blocks.push({
      layer: candidate.layer,
      ...(candidate.scope && { scope: candidate.scope }),
      title: candidate.title,
      source: candidate.source,
      text: value.text,
      chars: value.text.length,
      fullChars: value.full,
      cut: value.text.length < value.full,
      ...(candidate.proposed && { proposed: true }),
      ...(candidate.version !== undefined && { version: candidate.version }),
    })
  const humanSorted = [
    ...repoLevel,
    ...others.toSorted((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer)),
  ]
  for (const block of humanSorted) describe(block, placed.get(block) ?? { text: '', full: 0 })
  for (const block of generatedBlocks)
    describe(block, generatedTexts.get(block) ?? { text: '', full: 0 })
  if (notes)
    blocks.push({
      layer: 'notes',
      title: 'Team knowledge',
      source: 'Team knowledge',
      text: notesText,
      chars: notesText.length,
      fullChars: notesText.length,
      cut: notes.omitted.length > 0,
    })

  const body = [
    ...humanSorted.map((block) => placed.get(block)?.text ?? ''),
    ...generatedBlocks.map((block) => generatedTexts.get(block)?.text ?? ''),
    notesText,
  ].join('')
  const text = body ? `${header}${body}`.trimEnd() : ''
  return {
    text,
    sections,
    blocks,
    warnings,
    budget: {
      ...caps,
      used: text.length,
      humanUsed: body ? humanUsed : 0,
      generatedUsed,
      notesUsed: notesText.length,
    },
  }
}

/** Prompt order of human blocks: precedence, strongest first. */
const order: GuideLayer[] = [
  'repo-file',
  'repo',
  'family',
  'subgroup',
  'group',
  'all',
  'learnings',
  'policies',
]

function cutBlock(candidate: Candidate, room: number): string {
  const head = `## ${candidate.title}\n\n`
  const cut = cutText(candidate.body.trim(), room - head.length - 2)
  return cut ? `${head}${cut}\n\n` : ''
}
