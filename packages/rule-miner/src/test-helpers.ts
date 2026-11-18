import type { DiffFile, Discussion, GitForge, MergeRequestRecord } from '@holtkeeper/forge'
import type {
  AuditEventInput,
  AuditStore,
  KvStore,
  Learning,
  LearningStore,
} from '@holtkeeper/store'

export const mergeRequest = (
  id: number,
  overrides: Partial<MergeRequestRecord> = {},
): MergeRequestRecord => ({
  id,
  title: `Add widget panel ${id}`,
  description: '',
  sourceBranch: `feature/${id}`,
  targetBranch: 'main',
  state: 'merged',
  draft: false,
  labels: [],
  author: 'dev-one',
  webUrl: `https://forge.test/acme/widgets/-/merge_requests/${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: `2026-10-${String(id - 1).padStart(2, '0')}T00:00:00.000Z`,
  mergedAt: `2026-10-${String(id - 1).padStart(2, '0')}T00:00:00.000Z`,
  headSha: `final-${id}`,
  ...overrides,
})

export const note = (id: string, author: string, body: string, system = false) => ({
  id,
  author,
  body,
  createdAt: '2026-10-05T00:00:00.000Z',
  system,
})

export const thread = (
  id: string,
  notes: ReturnType<typeof note>[],
  options: { resolved?: boolean; position?: Discussion['position'] } = {},
): Discussion => ({
  id,
  resolvable: true,
  resolved: options.resolved ?? false,
  notes,
  ...(options.position && { position: options.position }),
})

export const at = (path: string, line: number, headSha = 'early'): Discussion['position'] => ({
  path,
  line,
  side: 'new',
  headSha,
})

/** A diff that replaces line `line` of each path. */
export const replacing = (line: number, ...paths: string[]): DiffFile[] =>
  paths.map((path) => ({
    oldPath: path,
    newPath: path,
    status: 'modified',
    diff: `@@ -${line - 1},3 +${line - 1},3 @@\n keep\n-old\n+new\n keep\n`,
  }))

export function fakeForge(
  records: MergeRequestRecord[],
  discussions: Record<number, Discussion[] | Error>,
  changes: DiffFile[] = [],
) {
  const calls: string[] = []
  const forge: Pick<
    GitForge,
    'listMergeRequests' | 'listDiscussions' | 'compareCommits' | 'getMergeRequest'
  > = {
    async listMergeRequests(repo, query) {
      calls.push(`list ${repo} ${query?.state} ${query?.updatedAfter} ${query?.limit}`)
      return records
    },
    async listDiscussions(repo, id) {
      calls.push(`discussions ${repo} ${id}`)
      const found = discussions[id] ?? []
      if (found instanceof Error) throw found
      return found
    },
    async compareCommits(repo, from, to) {
      calls.push(`compare ${repo} ${from} ${to}`)
      return changes
    },
  }
  return { forge, calls }
}

export function fakeStore(initial: Learning[] = []) {
  const learnings = new Map(initial.map((learning) => [learning.id, structuredClone(learning)]))
  const values = new Map<string, unknown>()
  const events: AuditEventInput[] = []
  const learningStore: Partial<LearningStore> = {
    get: async (id) => structuredClone(learnings.get(id)),
    list: async () => [...learnings.values()].map((learning) => structuredClone(learning)),
    find: async (key) => [...learnings.values()].find((learning) => learning.key === key),
    put: async (learning) => {
      learnings.set(learning.id, structuredClone(learning))
    },
  }
  const kv: Partial<KvStore> = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value)
    },
  }
  const audit: Partial<AuditStore> = {
    append: async (event) => {
      events.push(event)
      return { ...event, id: String(events.length), seq: events.length, prevHash: '', hash: '' }
    },
  }
  return {
    store: {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the methods the miner calls
      learnings: learningStore as LearningStore,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      kv: kv as KvStore,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      audit: audit as AuditStore,
    },
    learnings,
    values,
    events,
  }
}

export const learning = (overrides: Partial<Learning>): Learning => ({
  id: 'l-1',
  text: 'Some rule.',
  key: 'some rule',
  scope: { repos: ['gitlab:acme/widgets'] },
  origin: 'reply',
  status: 'active',
  sources: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  activeAt: '2026-09-01T00:00:00.000Z',
  lastReinforcedAt: '2026-09-01T00:00:00.000Z',
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  ...overrides,
})
