import type { RepoTarget } from '@holtkeeper/access'
import type { KnowledgeNeighbour } from '@holtkeeper/knowledge'
import { resolveRepoTests } from '@holtkeeper/settings'
import type { GuideSectionName, KnowledgeEntry, Store } from '@holtkeeper/store'

import { digestedDocs } from './digest.ts'
import { familyOf } from './families.ts'
import { type GuideTask, guideSections, repoKey, scopesFor, sectionsForTask } from './model.ts'
import { policiesFor } from './policies.ts'
import { type GuideCaps, type RepoDoc, type ResolvedGuide, resolveGuide } from './resolve.ts'

/** What one resolution is for. */
export interface GuideRequest {
  repo: RepoTarget
  task: GuideTask
  section?: GuideSectionName
  /** The sections to read instead of the task's. */
  focus?: readonly GuideSectionName[]
  /** The repository's own rules files, when the caller has a checkout or read them from the forge. */
  repoDocs?: readonly RepoDoc[]
  /** Text to rank knowledge notes by. */
  query?: string
  /**
   * Repository-relative paths the task touches, e.g. a merge request's changed files; notes whose
   * `match.files` none of them matches are left out. Absent: every note may apply.
   */
  files?: readonly string[]
  /**
   * Knowledge entry id → cosine with the query's vector (the server computes it when vectors are
   * on); ranks the notes, never makes one apply. Absent: text relevance only.
   */
  semantic?: ReadonlyMap<string, number>
  /**
   * Repositories like this one (e.g. `repoNeighbours`) whose knowledge goes into the lowest-priority
   * block (`GuideNotes.neighbours`). A neighbour without `family` gets the one the store knows.
   */
  neighbours?: {
    repos: readonly KnowledgeNeighbour[]
    /**
     * Which accepted entries the block may use, e.g. only those the task's team may read; the
     * caller's access rule. Default: every accepted entry.
     */
    readable?: (entry: KnowledgeEntry) => boolean
    /** Most characters of the block; default `GUIDE_NEIGHBOURS_SHARE` of the total. */
    maxChars?: number
  }
  /** Task kind notes must apply to. Default: the task (`review`, `chat`, ...). */
  taskKind?: string
  /**
   * Most characters for notes; 0 leaves them out, the neighbour block too. Default: whatever the
   * budget leaves.
   */
  notesChars?: number
  caps?: Partial<GuideCaps>
}

/** Resolves the Guide of a repository for a task from the store. */
export type GuideResolver = (request: GuideRequest) => Promise<ResolvedGuide>

/**
 * The single Guide resolver review, thread replies, agent tasks, release notes and MCP use: reads
 * the repository's family, the sections of its scopes, its policies from settings and accepted
 * knowledge, then runs `resolveGuide`; with `neighbours`, the knowledge of similar repositories
 * the caller's `readable` allows goes into the lowest-priority block. For a repository with no tests by design (`repo.tests`) the
 * `testing` sections are left out. `teamTitle` names team keys in block titles.
 */
export function createGuideResolver(deps: {
  store: Pick<Store, 'guides' | 'families' | 'knowledge' | 'settings'> & Partial<Pick<Store, 'kv'>>
  teamTitle?: (key: string) => string
}): GuideResolver {
  const { store } = deps
  return async (request) => {
    const families = await store.families.list()
    const family = familyOf(families, repoKey(request.repo))
    const notesChars = request.notesChars
    const [stored, settings, entries] = await Promise.all([
      store.guides.list({
        scopes: scopesFor(request.repo, family?.id),
        sections: request.focus
          ? guideSections.filter((name) => request.focus?.includes(name))
          : sectionsForTask(request.task, request.section),
      }),
      store.settings.list(),
      notesChars === 0 ? [] : store.knowledge.list({ status: 'accepted' }),
    ])
    const repoDocs =
      request.repoDocs &&
      (await digestedDocs({
        kv: store.kv,
        forgeId: request.repo.forge,
        repo: request.repo.path,
        task: request.task,
        docs: request.repoDocs,
      }))
    const tests = resolveRepoTests(settings, request.repo).expected
    const sections = tests ? stored : stored.filter((row) => row.section !== 'testing')
    return resolveGuide({
      repo: request.repo,
      task: request.task,
      ...(request.section && { section: request.section }),
      ...(request.focus && { focus: request.focus }),
      ...(family && { family: { id: family.id, name: family.name } }),
      sections,
      ...(repoDocs && { repoDocs }),
      policies: policiesFor(settings, request.repo),
      ...(notesChars !== 0 && {
        notes: {
          entries,
          kind: request.taskKind ?? request.task,
          ...(request.query && { query: request.query }),
          ...(request.files && { files: request.files }),
          ...(request.semantic && { semantic: request.semantic }),
          ...(notesChars !== undefined && { maxChars: notesChars }),
          ...(request.neighbours?.repos.length && {
            neighbours: {
              repos: request.neighbours.repos.map((neighbour) => {
                const known = neighbour.family ?? familyOf(families, repoKey(neighbour.repo))?.id
                return known === undefined ? neighbour : { ...neighbour, family: known }
              }),
              entries: request.neighbours.readable
                ? entries.filter(request.neighbours.readable)
                : entries,
              ...(request.neighbours.maxChars !== undefined && {
                maxChars: request.neighbours.maxChars,
              }),
            },
          }),
        },
      }),
      ...(request.caps && { caps: request.caps }),
      ...(deps.teamTitle && { teamTitle: deps.teamTitle }),
    })
  }
}
