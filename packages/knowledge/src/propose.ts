import type { RepoTarget, Scope } from '@holtkeeper/access'
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  Store,
} from '@holtkeeper/store'

import { classifyProposal } from './classify.ts'
import type { TaskPackage } from './model.ts'
import { KnowledgeValidationError, validateEntry } from './schema.ts'
import { contentHash, textOverlap } from './text.ts'

/** What an agent proposes. Everything but title and body is optional and gets classified. */
export interface ProposalInput {
  title: string
  body: string
  kind?: KnowledgeKind
  topics?: string[]
  appliesTo?: string[]
  packages?: KnowledgePackage[]
  /** Defaults to the proposing task's repository. */
  scope?: Scope
  evidence?: KnowledgeLink[]
}

/** The task that proposes; used for classification and the default scope. */
export interface ProposalTask {
  kind?: string
  repo?: RepoTarget
  packages?: TaskPackage[]
}

export interface ProposeEntryOptions {
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'activity'>>
  input: ProposalInput
  /** Agent actor id stored as `author`, e.g. `agent:review`. */
  actor: string
  task?: ProposalTask
  now: () => Date
  /** Kinds accepted without review. Default: none. */
  autoAccept?: readonly KnowledgeKind[]
  /** Word overlap (Jaccard, 0–1) from which a proposal counts as a duplicate. Default 0.8. */
  duplicateOverlap?: number
}

export interface ProposeResult {
  /** The new entry, or the existing one the proposal duplicates (with merged evidence). */
  entry: KnowledgeEntry
  created: boolean
  duplicateOf?: string
}

const repoScope = (repo: RepoTarget): Scope => ({ repos: [`${repo.forge}:${repo.path}`] })

/** The existing entry `input` repeats, if any: same title or body words, or high word overlap. */
function findDuplicate(
  input: ProposalInput,
  candidates: readonly KnowledgeEntry[],
  threshold: number,
): KnowledgeEntry | undefined {
  const title = contentHash(input.title)
  const body = contentHash(input.body)
  const text = `${input.title}\n${input.body}`
  let best: { entry: KnowledgeEntry; overlap: number } | undefined
  for (const entry of candidates) {
    if (contentHash(entry.title) === title || contentHash(entry.body) === body) return entry
    const overlap = textOverlap(text, `${entry.title}\n${entry.body}`)
    if (overlap >= threshold && overlap > (best?.overlap ?? 0)) best = { entry, overlap }
  }
  return best?.entry
}

/**
 * Records an agent's proposal. A proposal that repeats a proposed, accepted or rejected entry
 * creates nothing: its new evidence links are added to that entry and its id comes back as
 * `duplicateOf`. Otherwise the proposal is classified (`classifyProposal`), validated
 * (`validateEntry`, throwing `KnowledgeValidationError`) and stored as a `proposed` agent entry —
 * or `accepted` when its kind is in `autoAccept`. Both outcomes go to the activity log when the
 * store has one.
 */
export async function proposeEntry({
  store,
  input,
  actor,
  task = {},
  now,
  autoAccept = [],
  duplicateOverlap = 0.8,
}: ProposeEntryOptions): Promise<ProposeResult> {
  const at = now().toISOString()
  const candidates = await store.knowledge.list({ status: ['proposed', 'accepted', 'rejected'] })
  const duplicate = findDuplicate(input, candidates, duplicateOverlap)

  if (duplicate) {
    const known = new Set(duplicate.evidence.map((link) => link.url))
    const added = (input.evidence ?? []).filter((link) => !known.has(link.url))
    let entry = duplicate
    if (added.length) {
      const { version: _version, ...rest } = duplicate
      entry = await store.knowledge.put({
        ...rest,
        evidence: [...duplicate.evidence, ...added],
        updatedAt: at,
        updatedBy: actor,
      })
      await store.activity?.append({
        at,
        actor,
        action: 'knowledge.evidence-added',
        subject: entry.id,
        details: { urls: added.map((link) => link.url) },
      })
    }
    return { entry, created: false, duplicateOf: duplicate.id }
  }

  const classification = classifyProposal(input, {
    ...(task.kind !== undefined && { taskKind: task.kind }),
    ...(task.repo !== undefined && { repo: task.repo }),
    ...(task.packages !== undefined && { packages: task.packages }),
  })
  const scope = input.scope ?? (task.repo ? repoScope(task.repo) : {})
  const validation = validateEntry({
    title: input.title,
    body: input.body,
    scope,
    evidence: input.evidence ?? [],
    ...classification,
  })
  if (!validation.success) throw new KnowledgeValidationError(validation.issues)

  const { status: _status, ...draft } = validation.data
  const status = autoAccept.includes(draft.kind) ? 'accepted' : 'proposed'
  const entry = await store.knowledge.put({
    ...draft,
    id: crypto.randomUUID(),
    status,
    source: 'agent',
    author: actor,
    createdAt: at,
    updatedAt: at,
  })
  await store.activity?.append({
    at,
    actor,
    action: status === 'accepted' ? 'knowledge.accepted' : 'knowledge.proposed',
    subject: entry.id,
    details: { kind: entry.kind, source: 'agent', ...(task.kind && { task: task.kind }) },
  })
  return { entry, created: true }
}
