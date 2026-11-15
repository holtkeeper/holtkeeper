import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import type { GuideTask } from './model.ts'
import type { RepoDoc } from './resolve.ts'

/** Bumped when the digest prompt or format changes, so older digests are written again. */
export const DIGEST_VERSION = 1

/** Rules files shorter than this are used as they are; only longer ones are digested. */
export const DIGEST_MIN_CHARS = 3_000

/** What a digest line is for: every task, reviews, or writing code. */
export const digestGroups = ['general', 'review', 'code'] as const

export type DigestGroup = (typeof digestGroups)[number]

/** One condensed point of a rules file; `source` is a heading of the file that exists there. */
export interface DigestItem {
  text: string
  source?: string
}

/** A rules file condensed into groups by what the work needs; stored in `Store.kv`. */
export interface RepoDigest {
  version: number
  /** Git blob sha of the file text the digest was made from. */
  sha: string
  groups: Record<DigestGroup, DigestItem[]>
  model: string
  costUsd: number
  at: string
}

const items = z.array(z.object({ text: z.string(), source: z.string().optional() }))

const digestSchema: z.ZodType<RepoDigest> = z.object({
  version: z.number(),
  sha: z.string(),
  groups: z.object({ general: items, review: items, code: items }),
  model: z.string(),
  costUsd: z.number(),
  at: z.string(),
})

/** The `Store.kv` key of a rules file's digest; one per file, a new sha replaces it. */
export const digestKey = (forgeId: string, repo: string, file: string): string =>
  `guide:digest:${forgeId}:${repo}:${file}`

/**
 * The stored digests of `files`, by file path. A digest is dropped when it is of another
 * `DIGEST_VERSION` or, given `shas` (file path → blob sha), of another version of the file; without
 * `shas` the stored one is trusted, for callers that only hold a trimmed copy of the text.
 */
export async function readRepoDigests(input: {
  kv: Pick<KvStore, 'get'>
  forgeId: string
  repo: string
  files: readonly string[]
  shas?: ReadonlyMap<string, string>
}): Promise<Map<string, RepoDigest>> {
  const found = new Map<string, RepoDigest>()
  await Promise.all(
    input.files.map(async (file) => {
      const parsed = digestSchema.safeParse(
        await input.kv.get(digestKey(input.forgeId, input.repo, file)),
      )
      if (!parsed.success || parsed.data.version !== DIGEST_VERSION) return
      const sha = input.shas?.get(file)
      if (sha && sha !== parsed.data.sha) return
      found.set(file, parsed.data)
    }),
  )
  return found
}

/** The groups a task reads besides `general`. */
const groupsOf = (task: GuideTask): DigestGroup[] =>
  task === 'review'
    ? ['general', 'review']
    : task === 'release-notes'
      ? ['general']
      : ['general', 'code']

/**
 * The digest as prompt text for `task`: its `general` lines and those of the group the task needs,
 * each as a bullet with the heading it came from. Empty when the digest holds nothing for the task.
 */
export function renderDigest(digest: RepoDigest, task: GuideTask, file: string): string {
  const lines = groupsOf(task).flatMap((group) =>
    digest.groups[group].map((item) =>
      item.source ? `- ${item.text} (${file} § ${item.source})` : `- ${item.text}`,
    ),
  )
  return lines.length
    ? `Condensed from ${file} for ${task}; see the file for the rest.\n\n${lines.join('\n')}`
    : ''
}

/**
 * Replaces the text of long rules files that have a digest with the digest for `task`. Files
 * without a digest, short ones and digests with nothing for the task stay as they are.
 */
export function applyDigests(
  docs: readonly RepoDoc[],
  digests: ReadonlyMap<string, RepoDigest>,
  task: GuideTask,
): RepoDoc[] {
  return docs.map((doc) => {
    const digest = digests.get(doc.file)
    if (!digest || doc.text.length < DIGEST_MIN_CHARS) return doc
    const text = renderDigest(digest, task, doc.file)
    return text && text.length < doc.text.length ? { file: doc.file, text } : doc
  })
}

/**
 * `docs` with the digests stored for the repository applied for `task` (see `applyDigests`). Reads
 * only files long enough to have one; without `kv` or digests the docs come back unchanged.
 */
export async function digestedDocs(input: {
  kv: Pick<KvStore, 'get'> | undefined
  forgeId: string
  repo: string
  task: GuideTask
  docs: readonly RepoDoc[]
}): Promise<RepoDoc[]> {
  const long = input.docs.filter((doc) => doc.text.length >= DIGEST_MIN_CHARS)
  if (!input.kv || !long.length) return [...input.docs]
  const shas = new Map(long.flatMap((doc) => (doc.sha ? [[doc.file, doc.sha] as const] : [])))
  const digests = await readRepoDigests({
    kv: input.kv,
    forgeId: input.forgeId,
    repo: input.repo,
    files: long.map((doc) => doc.file),
    shas,
  })
  return applyDigests(input.docs, digests, input.task)
}
