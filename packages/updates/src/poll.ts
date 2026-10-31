import type {
  Discussion,
  ForgeEvent,
  GitForge,
  MergeRequestRecord,
  MergeRequestState,
  RepoRef,
} from '@holtkeeper/forge'

import type { PollEventKind } from './setting.ts'

/** What polling remembers about a merge request. */
export interface MergeRequestSnapshot {
  state: MergeRequestState
  draft: boolean
  labels: string[]
  updatedAt: string
  headSha?: string
  /** Newest note time seen and the note ids seen at exactly that time. */
  notesAfter?: string
  notesAt?: string[]
}

/** What a repository looked like at the last poll. JSON-serializable. */
export interface RepoCursor {
  /** When the last poll started; changes are read from shortly before it. */
  since: string
  mergeRequests: Record<string, MergeRequestSnapshot>
  /** Tag name to sha. */
  tags: Record<string, string>
  /** Branch name to head sha; missing until branches are polled once. */
  branches?: Record<string, string>
  /** Finished pipelines already reported, newest last. */
  pipelines: number[]
}

export interface PollInput {
  forge: GitForge
  repo: RepoRef
  /** `undefined` on the first poll: it records the current state and reports nothing. */
  cursor: RepoCursor | undefined
  now: Date
  events: readonly PollEventKind[]
}

export interface PollResult {
  events: ForgeEvent[]
  cursor: RepoCursor
  /** Forge calls made, about one HTTP request each. */
  requests: number
}

/** Changes are read from this long before the previous poll, for clock skew between hosts. */
const OVERLAP_MS = 2 * 60_000
/** Closed and merged merge requests are forgotten after this long. */
const KEEP_CLOSED_MS = 7 * 86_400_000
const MAX_MERGE_REQUESTS = 100
const MAX_TAGS = 100
const LISTED_TAGS = 20
const MAX_PIPELINES = 200
const MAX_BRANCHES = 500

const iso = (ms: number) => new Date(ms).toISOString()

const actionOf = (
  previous: MergeRequestSnapshot | undefined,
  current: MergeRequestRecord,
): string | undefined => {
  if (!previous)
    return current.state === 'open' ? 'open' : current.state === 'merged' ? 'merge' : 'close'
  if (previous.state === current.state) return undefined
  if (current.state === 'merged') return 'merge'
  if (current.state === 'closed') return 'close'
  return 'reopen'
}

const snapshotOf = (
  record: MergeRequestRecord,
  headSha: string | undefined,
  notes: Pick<MergeRequestSnapshot, 'notesAfter' | 'notesAt'>,
): MergeRequestSnapshot => ({
  state: record.state,
  draft: record.draft,
  labels: record.labels,
  updatedAt: record.updatedAt,
  ...(headSha && { headSha }),
  ...(notes.notesAfter && { notesAfter: notes.notesAfter }),
  ...(notes.notesAt?.length && { notesAt: notes.notesAt }),
})

/**
 * Looks at one repository and reports what changed since `cursor` as forge events, in the order
 * they matter: merge request changes, then comments, finished pipelines, tags and branch pushes. Calls only the
 * optional `GitForge` reads the forge has; kinds it cannot read are skipped. A change seen once is
 * not reported again, so overlapping windows are harmless.
 */
export async function pollRepository(input: PollInput): Promise<PollResult> {
  const { forge, repo, now } = input
  const previous = input.cursor
  const wants = new Set(input.events)
  const baseline = previous === undefined
  const since = previous ? Date.parse(previous.since) - OVERLAP_MS : now.getTime()
  let requests = 0
  const call = <T>(work: () => Promise<T>) => {
    requests += 1
    return work()
  }

  const events: ForgeEvent[] = []
  const notes: ForgeEvent[] = []
  const mergeRequests: Record<string, MergeRequestSnapshot> = {}
  const needMergeRequests =
    wants.has('mergeRequests') || wants.has('notes') || wants.has('pipelines')

  if (needMergeRequests && forge.listMergeRequests) {
    const list = forge.listMergeRequests.bind(forge)
    const changed = await call(() =>
      baseline
        ? list(repo.path, { state: 'open', limit: MAX_MERGE_REQUESTS })
        : list(repo.path, { updatedAfter: iso(since), limit: MAX_MERGE_REQUESTS }),
    )
    for (const [iid, snapshot] of Object.entries(previous?.mergeRequests ?? {}))
      if (
        snapshot.state === 'open' ||
        now.getTime() - Date.parse(snapshot.updatedAt) < KEEP_CLOSED_MS
      )
        mergeRequests[iid] = snapshot

    for (const record of changed) {
      const before = previous?.mergeRequests[String(record.id)]
      if (before && before.updatedAt === record.updatedAt) continue
      let headSha = record.headSha
      if (!headSha && record.state === 'open' && forge.getMergeRequest) {
        const getMergeRequest = forge.getMergeRequest.bind(forge)
        headSha = (await call(() => getMergeRequest(repo.path, record.id))).headSha
      }
      let noteState: Pick<MergeRequestSnapshot, 'notesAfter' | 'notesAt'> = {
        notesAfter: before?.notesAfter ?? (baseline ? now.toISOString() : record.createdAt),
        notesAt: before?.notesAt ?? [],
      }

      if (!baseline) {
        const action = actionOf(before, record)
        const newCommits =
          before?.headSha !== undefined && headSha !== undefined && before.headSha !== headSha
        const leftDraft = before?.draft === true && !record.draft
        const known = new Set(before?.labels ?? [])
        const labelsAdded = before ? record.labels.filter((label) => !known.has(label)) : []
        const update =
          before && record.state === 'open' && (newCommits || leftDraft || labelsAdded.length > 0)
        if (wants.has('mergeRequests') && (action || update))
          events.push({
            kind: 'mergeRequest',
            repo,
            action: action ?? 'update',
            actor: '',
            newCommits,
            leftDraft,
            labelsAdded,
            mr: { ...record, ...(headSha && { headSha }) },
          })

        if (wants.has('notes') && forge.listDiscussions) {
          const listDiscussions = forge.listDiscussions.bind(forge)
          const discussions = await call(() => listDiscussions(repo.path, record.id))
          const found = newNotes(discussions, noteState)
          noteState = found.state
          for (const { discussion, note } of found.notes)
            notes.push({
              kind: 'note',
              repo,
              mergeRequest: record.id,
              mergeRequestState: record.state,
              ...(headSha && { headSha }),
              author: note.author,
              body: note.body,
              discussionId: discussion.id,
              inThread:
                discussion.notes.length > 1 ||
                discussion.resolvable ||
                discussion.position !== undefined,
            })
        }
      }
      mergeRequests[String(record.id)] = snapshotOf(record, headSha, noteState)
    }
  }
  events.push(...notes)

  const pipelines = [...(previous?.pipelines ?? [])]
  if (wants.has('pipelines')) {
    const runs = await call(() =>
      forge.listPipelines(repo.path, baseline ? {} : { updatedAfter: iso(since) }),
    )
    const seen = new Set(pipelines)
    const heads = new Map(
      Object.entries(mergeRequests)
        .filter(([, snapshot]) => snapshot.state === 'open' && snapshot.headSha)
        .map(([iid, snapshot]) => [snapshot.headSha, Number(iid)]),
    )
    for (const run of runs.toReversed()) {
      if (run.status !== 'success' && run.status !== 'failed') continue
      if (seen.has(run.id)) continue
      seen.add(run.id)
      pipelines.push(run.id)
      const iid = heads.get(run.sha)
      if (baseline || iid === undefined) continue
      events.push({
        kind: 'pipeline',
        repo,
        mergeRequest: iid,
        pipelineId: run.id,
        status: run.status,
        sha: run.sha,
        actor: '',
      })
    }
  }

  const tags = { ...previous?.tags }
  if (wants.has('tags') && forge.listTags) {
    const listTags = forge.listTags.bind(forge)
    const listed = await call(() => listTags(repo.path, { limit: LISTED_TAGS }))
    for (const tag of listed.toReversed()) {
      if (tags[tag.name] === tag.sha) continue
      tags[tag.name] = tag.sha
      if (!baseline) events.push({ kind: 'tag', repo, tag: tag.name, sha: tag.sha })
    }
  }

  let branches = previous?.branches
  if (wants.has('pushes') && forge.listBranches) {
    const listBranches = forge.listBranches.bind(forge)
    const listed = await call(() => listBranches(repo.path))
    const known = branches
    branches = {}
    for (const branch of listed.toSorted((a, b) => a.committedAt.localeCompare(b.committedAt))) {
      branches[branch.name] = branch.sha
      if (known && known[branch.name] !== branch.sha)
        events.push({ kind: 'push', repo, branch: branch.name, sha: branch.sha, actor: '' })
    }
    branches = Object.fromEntries(Object.entries(branches).slice(-MAX_BRANCHES))
  }

  return {
    events,
    requests,
    cursor: {
      since: now.toISOString(),
      mergeRequests: Object.fromEntries(
        Object.entries(mergeRequests)
          .toSorted(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_MERGE_REQUESTS * 2),
      ),
      tags: Object.fromEntries(Object.entries(tags).slice(-MAX_TAGS)),
      pipelines: pipelines.slice(-MAX_PIPELINES),
      ...(branches && { branches }),
    },
  }
}

/** Notes newer than `state`, oldest first, and the state that remembers them. */
function newNotes(
  discussions: readonly Discussion[],
  state: Pick<MergeRequestSnapshot, 'notesAfter' | 'notesAt'>,
) {
  const after = state.notesAfter ?? ''
  const atEdge = new Set(state.notesAt ?? [])
  const found = discussions
    .flatMap((discussion) => discussion.notes.map((note) => ({ discussion, note })))
    .filter(({ note }) => !note.system)
    .filter(
      ({ note }) =>
        note.createdAt > after || (note.createdAt === after && !atEdge.has(String(note.id))),
    )
    .toSorted((a, b) => a.note.createdAt.localeCompare(b.note.createdAt))
  const newest = found.at(-1)?.note.createdAt
  if (!newest) return { notes: found, state }
  const edge = found
    .filter(({ note }) => note.createdAt === newest)
    .map(({ note }) => String(note.id))
  return {
    notes: found,
    state: { notesAfter: newest, notesAt: newest === after ? [...atEdge, ...edge] : edge },
  }
}
