import type { Agent, AgentTask } from '@holtkeeper/agent'
import type {
  DiffFile,
  Discussion,
  GitForge,
  MergeRequest,
  ReviewSubmission,
} from '@holtkeeper/forge'

export const HEAD = 'h'.repeat(40)
const BASE = 'b'.repeat(40)

const mergeRequest: MergeRequest & { headSha: string } = {
  id: 7,
  title: 'Add pricing',
  description: 'Adds a price calculator.',
  sourceBranch: 'feat/price',
  targetBranch: 'main',
  state: 'open',
  draft: false,
  labels: [],
  author: 'jane',
  webUrl: 'https://gitlab.test/games/a/-/merge_requests/7',
  headSha: HEAD,
}

interface FakeForgeState {
  files: DiffFile[]
  discussions: Discussion[]
  compare?: DiffFile[]
  contents?: Record<string, string>
  bytes?: Record<string, Uint8Array>
  reject?: (comment: ReviewSubmission['comments'][number]) => string | undefined
}

/** A forge that records what the review posts. */
export function fakeForge(state: FakeForgeState) {
  const submissions: ReviewSubmission[] = []
  const replies: { discussionId: string; body: string }[] = []
  const resolved: string[] = []
  const notes: string[] = []
  const compared: [string, string][] = []
  const forge = {
    kind: 'gitlab',
    getMergeRequest: async () => ({ ...mergeRequest }),
    getMergeRequestDiff: async () => ({
      refs: { baseSha: BASE, startSha: BASE, headSha: HEAD },
      files: state.files,
    }),
    listDiscussions: async () => state.discussions,
    compareCommits: async (_repo: string, from: string, to: string) => {
      compared.push([from, to])
      return state.compare ?? []
    },
    readFile: async (_repo: string, file: string) => state.contents?.[file],
    readFileBytes: async (_repo: string, file: string) => state.bytes?.[file],
    submitReview: async (_repo: string, _id: number, review: ReviewSubmission) => {
      submissions.push(review)
      const failed = review.comments.flatMap((comment) => {
        const error = state.reject?.(comment)
        return error ? [{ comment, error }] : []
      })
      return { posted: review.comments.length - failed.length, failed }
    },
    replyToDiscussion: async (_repo: string, _id: number, discussionId: string, body: string) => {
      replies.push({ discussionId, body })
    },
    resolveDiscussion: async (_repo: string, _id: number, discussionId: string) => {
      resolved.push(discussionId)
    },
    commentOnMergeRequest: async (_repo: string, _id: number, body: string) => {
      notes.push(body)
    },
  } as unknown as GitForge
  return { forge, submissions, replies, resolved, notes, compared }
}

/** An agent that answers each task with the next scripted output, by task kind. */
export function fakeAgent(outputs: Record<string, unknown[]>) {
  const tasks: AgentTask[] = []
  const agent: Agent = {
    name: 'fake',
    async run<Output>(task: AgentTask<Output>) {
      tasks.push(task)
      const queue = outputs[task.taskKind ?? 'review'] ?? []
      const output = queue.shift() as Output
      return {
        text: '',
        output,
        turns: 2,
        costUsd: 0.01,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }
  return { agent, tasks }
}

/** A unified diff body adding `lines` at `start` of a new file. */
export const addedFile = (lines: string[], start = 1) =>
  `@@ -0,0 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
