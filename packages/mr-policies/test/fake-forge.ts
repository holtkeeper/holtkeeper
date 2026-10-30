import type {
  DiffFile,
  GitForge,
  MergeOptions,
  MergeRequest,
  Pipeline,
  ReviewSubmission,
  UpdateMergeRequestInput,
} from '@holtkeeper/forge'

import type { MergeRequestEvent } from '../src/model.ts'

interface FakeForgeOptions {
  files?: DiffFile[]
  pipelines?: Pipeline[]
  headSha?: string
  /** Leave out optional review methods. */
  minimal?: boolean
  reviewers?: boolean
  failMerge?: boolean
}

interface ForgeCall {
  method: string
  args: unknown[]
}

export const diffFile = (path: string, lines = 1, extra: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: path,
  newPath: path,
  status: 'modified',
  diff: `@@ -1 +1 @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')}`,
  ...extra,
})

export function fakeForge(options: FakeForgeOptions = {}) {
  const calls: ForgeCall[] = []
  const counts = { diff: 0, pipelines: 0, getMergeRequest: 0 }
  const headSha = options.headSha ?? 'sha1'
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args })
  const forge: Record<string, unknown> = {
    kind: 'fake',
    async updateMergeRequest(repo: string, id: number, input: UpdateMergeRequestInput) {
      record('updateMergeRequest', repo, id, input)
      return {}
    },
    async mergeMergeRequest(repo: string, id: number, merge?: MergeOptions) {
      record('mergeMergeRequest', repo, id, merge)
      if (options.failMerge) throw new Error('merge conflict')
    },
    async commentOnMergeRequest(repo: string, id: number, body: string) {
      record('commentOnMergeRequest', repo, id, body)
    },
    async listPipelines(repo: string, query: { sha?: string }) {
      counts.pipelines++
      record('listPipelines', repo, query)
      return (options.pipelines ?? []).filter((pipeline) => pipeline.sha === query.sha)
    },
  }
  if (!options.minimal) {
    forge.getMergeRequestDiff = async () => {
      counts.diff++
      return {
        refs: { baseSha: 'base', startSha: 'start', headSha },
        files: options.files ?? [],
      }
    }
    forge.getMergeRequest = async () => {
      counts.getMergeRequest++
      return { headSha }
    }
    forge.submitReview = async (repo: string, id: number, review: ReviewSubmission) => {
      record('submitReview', repo, id, review)
      return { posted: 0, failed: [] }
    }
  }
  if (options.reviewers) {
    forge.assignReviewers = async (repo: string, id: number, reviewers: string[]) => {
      record('assignReviewers', repo, id, reviewers)
    }
  }
  return { forge: forge as unknown as GitForge, calls, counts }
}

export const pipeline = (status: Pipeline['status'], id = 1, sha = 'sha1'): Pipeline => ({
  id,
  ref: 'feature',
  sha,
  status,
  webUrl: '',
})

export function mrEvent(
  overrides: Partial<Omit<MergeRequestEvent, 'mr'>> & {
    mr?: Partial<MergeRequest & { headSha?: string }>
  } = {},
): MergeRequestEvent {
  const { mr, ...rest } = overrides
  return {
    repo: { forge: 'work', path: 'games/slots' },
    groups: ['games'],
    action: 'open',
    actor: 'alice',
    isBot: false,
    ...rest,
    mr: {
      id: 7,
      title: 'feat: add slots',
      description: '',
      sourceBranch: 'feature/slots',
      targetBranch: 'main',
      state: 'open',
      draft: false,
      labels: [],
      author: 'alice',
      webUrl: '',
      ...mr,
    },
  }
}
