import type { RepoTarget } from '@holtkeeper/access'
import type { GuideSectionName, Store } from '@holtkeeper/store'

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
  /** Task kind notes must apply to. Default: the task (`review`, `chat`, ...). */
  taskKind?: string
  /** Most characters for notes; 0 leaves them out. Default: whatever the budget leaves. */
  notesChars?: number
  caps?: Partial<GuideCaps>
}

/** Resolves the Guide of a repository for a task from the store. */
export type GuideResolver = (request: GuideRequest) => Promise<ResolvedGuide>

/**
 * The single Guide resolver review, thread replies, agent tasks, release notes and MCP use: reads
 * the repository's family, the sections of its scopes, its policies from settings and accepted
 * knowledge, then runs `resolveGuide`.
 */
export function createGuideResolver(deps: {
  store: Pick<Store, 'guides' | 'families' | 'knowledge' | 'settings'>
}): GuideResolver {
  const { store } = deps
  return async (request) => {
    const family = familyOf(await store.families.list(), repoKey(request.repo))
    const notesChars = request.notesChars
    const [sections, settings, entries] = await Promise.all([
      store.guides.list({
        scopes: scopesFor(request.repo, family?.id),
        sections: request.focus
          ? guideSections.filter((name) => request.focus?.includes(name))
          : sectionsForTask(request.task, request.section),
      }),
      store.settings.list(),
      notesChars === 0 ? [] : store.knowledge.list({ status: 'accepted' }),
    ])
    return resolveGuide({
      repo: request.repo,
      task: request.task,
      ...(request.section && { section: request.section }),
      ...(request.focus && { focus: request.focus }),
      ...(family && { family: { id: family.id, name: family.name } }),
      sections,
      ...(request.repoDocs && { repoDocs: request.repoDocs }),
      policies: policiesFor(settings, request.repo),
      ...(notesChars !== 0 && {
        notes: {
          entries,
          kind: request.taskKind ?? request.task,
          ...(request.query && { query: request.query }),
          ...(notesChars !== undefined && { maxChars: notesChars }),
        },
      }),
      ...(request.caps && { caps: request.caps }),
    })
  }
}
