import type { GitForge, MergeRequest } from '@holtkeeper/forge'

import { type ChangePlan, type PlanOptions, planChanges } from './apply.ts'
import type { CodeChange } from './types.ts'

export interface MergeRequestOptions extends PlanOptions {
  forge: GitForge
  /** Repository path on the forge, e.g. `games/app-x`. */
  repo: string
  changes: readonly CodeChange[]
  title: string
  description?: string
  /** Branch the changes apply to and the merge request targets. Default: the default branch. */
  base?: string
  /** Default `holtkeeper/<slug of title>-<short id>`. */
  branch?: string
  labels?: string[]
}

export interface MergeRequestOutcome {
  plan: ChangePlan
  /** Absent when no change applied cleanly. */
  mergeRequest?: MergeRequest
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'changes'

/**
 * Applies changes to the forge's current files and opens a merge request with them — one commit
 * through the API, no clone. Conflicting changes are left out and reported in `plan.conflicts`.
 * Binary files are read with `forge.readFileBytes` when the forge has it and committed as base64.
 */
export async function openMergeRequest(options: MergeRequestOptions): Promise<MergeRequestOutcome> {
  const { forge, repo, changes, title } = options
  const base = options.base ?? (await forge.getRepository(repo)).defaultBranch
  const plan = await planChanges(
    changes,
    {
      read: (file) => forge.readFile(repo, file, base),
      ...(forge.readFileBytes
        ? { readBytes: async (file: string) => forge.readFileBytes?.(repo, file, base) }
        : {}),
    },
    { resolveArtifact: (id) => options.resolveArtifact?.(id) },
  )
  if (plan.applied.length === 0) return { plan }

  const branch = options.branch ?? `holtkeeper/${slug(title)}-${crypto.randomUUID().slice(0, 8)}`
  await forge.commit(repo, {
    branch,
    startBranch: base,
    message: title,
    changes: plan.files.map(({ file, content, bytes, existed }) =>
      bytes
        ? {
            action: existed ? 'update' : 'create',
            path: file,
            content: Buffer.from(bytes).toString('base64'),
            encoding: 'base64',
          }
        : content === undefined
          ? { action: 'delete', path: file }
          : { action: existed ? 'update' : 'create', path: file, content },
    ),
  })
  const mergeRequest = await forge.createMergeRequest(repo, {
    sourceBranch: branch,
    targetBranch: base,
    title,
    description:
      options.description ??
      plan.applied
        .map((id) => `- ${changes.find((change) => change.id === id)?.title ?? id}`)
        .join('\n'),
    labels: options.labels ?? ['holtkeeper'],
  })
  return { plan, mergeRequest }
}
