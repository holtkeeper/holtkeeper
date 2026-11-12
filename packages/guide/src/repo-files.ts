import { createHash } from 'node:crypto'

import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

import type { RepoDoc } from './resolve.ts'

/** A rules file of a repository read from its forge. */
export interface RepoRuleFile {
  path: string
  /** Git blob sha of the text. */
  sha: string
  text: string
}

/** What `readRepoRuleFiles` needs from a forge client. */
export interface RuleFilesForge {
  readFile(repo: string, file: string, ref?: string): Promise<string | undefined>
  headCommit?(repo: string): Promise<string | undefined>
}

/** Git's blob id of `text`, the sha a forge reports for the file. */
export const blobSha = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

const cachedFiles = z.array(z.object({ path: z.string(), sha: z.string(), text: z.string() }))

const ruleFilesKey = (forge: string, repo: string, sha: string) =>
  `guide:repo-files:${forge}:${repo}:${sha}`

/**
 * The rules files of a repository (`files`, in that order) that exist and are not blank, read at
 * the default branch head. With a head sha and `kv`, the result is kept under that sha for
 * `ttlSeconds` (default 7 days) and served from there while the head stays; without a head sha
 * every call reads the forge.
 */
export async function readRepoRuleFiles(input: {
  forge: RuleFilesForge
  forgeId: string
  repo: string
  files: readonly string[]
  kv?: Pick<KvStore, 'get' | 'set'>
  ttlSeconds?: number
}): Promise<{ sha?: string; files: RepoRuleFile[] }> {
  const head = await input.forge.headCommit?.(input.repo)
  const key = head && ruleFilesKey(input.forgeId, input.repo, head)
  if (key && input.kv) {
    const cached = cachedFiles.safeParse(await input.kv.get(key))
    if (cached.success) return { sha: head, files: cached.data }
  }
  const texts = await Promise.all(
    input.files.map((file) => input.forge.readFile(input.repo, file, head)),
  )
  const files = input.files.flatMap((path, index) => {
    const text = texts[index]?.trim()
    return text ? [{ path, sha: blobSha(texts[index] ?? ''), text }] : []
  })
  if (key && input.kv) await input.kv.set(key, files, input.ttlSeconds ?? 7 * 24 * 3600)
  return { ...(head && { sha: head }), files }
}

/** Rules files as the resolver takes them. */
export const repoDocsOf = (files: readonly RepoRuleFile[]): RepoDoc[] =>
  files.map((file) => ({ file: file.path, text: file.text }))
