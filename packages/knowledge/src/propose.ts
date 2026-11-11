import type { RepoTarget, Scope } from '@holtkeeper/access'
import type {
  KnowledgeEntry,
  KnowledgeKind,
  KnowledgeLink,
  KnowledgePackage,
  KnowledgeVisibility,
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
  /** Default: see `sharingDefaults`. */
  visibility?: KnowledgeVisibility
  subject?: string
}

/** The task that proposes; used for classification and the default scope. */
export interface ProposalTask {
  kind?: string
  repo?: RepoTarget
  packages?: TaskPackage[]
}

export interface ProposeEntryOptions {
  store: Pick<Store, 'knowledge'> & Partial<Pick<Store, 'audit'>>
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

/** `npm:react` or `Go:github.com/acme/kit`: the `subject` of an entry about one package. */
export const packageSubject = (pkg: Pick<KnowledgePackage, 'ecosystem' | 'name'>): string =>
  `${pkg.ecosystem.toLowerCase() === 'go' ? 'Go' : pkg.ecosystem}:${pkg.name}`

/**
 * The subject and visibility an entry gets when its author sets none: an entry about exactly one
 * package has that package as its subject, and decisions and conventions with a subject are
 * `shared`, so other teams see what a team decided about a library. Everything else stays `team`.
 */
export function sharingDefaults(draft: {
  kind: KnowledgeKind
  packages?: readonly KnowledgePackage[] | undefined
  subject?: string | undefined
  visibility?: KnowledgeVisibility | undefined
}): { subject?: string; visibility?: KnowledgeVisibility } {
  const [only, ...rest] = draft.packages ?? []
  const subject = draft.subject ?? (only && !rest.length ? packageSubject(only) : undefined)
  const visibility =
    draft.visibility ??
    (subject && (draft.kind === 'decision' || draft.kind === 'convention') ? 'shared' : undefined)
  return { ...(subject && { subject }), ...(visibility && { visibility }) }
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
 * or `accepted` when its kind is in `autoAccept`. Both outcomes are audited (`knowledge.propose`,
 * `knowledge.accept`, `knowledge.evidence`) against the task's repository when the store has an
 * audit log.
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
  const audit = (action: string, id: string, details: Record<string, unknown>) =>
    store.audit?.append({
      at,
      actor: { id: actor, name: actor, provider: 'agent' },
      via: 'job',
      action,
      target: {
        type: 'knowledge',
        id,
        ...(task.repo && { repo: `${task.repo.forge}:${task.repo.path}` }),
      },
      outcome: 'ok',
      details,
    })
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
      await audit('knowledge.evidence', entry.id, { urls: added.map((link) => link.url) })
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
    ...(input.visibility && { visibility: input.visibility }),
    ...(input.subject && { subject: input.subject }),
  })
  if (!validation.success) throw new KnowledgeValidationError(validation.issues)

  const { status: _status, ...draft } = validation.data
  const status = autoAccept.includes(draft.kind) ? 'accepted' : 'proposed'
  const entry = await store.knowledge.put({
    ...draft,
    ...sharingDefaults(draft),
    id: crypto.randomUUID(),
    status,
    source: 'agent',
    author: actor,
    createdAt: at,
    updatedAt: at,
  })
  await audit(status === 'accepted' ? 'knowledge.accept' : 'knowledge.propose', entry.id, {
    title: entry.title,
    kind: entry.kind,
    ...(task.kind && { task: task.kind }),
  })
  return { entry, created: true }
}
