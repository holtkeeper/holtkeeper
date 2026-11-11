import type { GitForge } from '@holtkeeper/forge'

/**
 * The commit the repository's default branch points at, read through the forge: `headCommit` when
 * the forge has it, else the newest commit of the default branch. `undefined` when the forge
 * cannot tell or the read fails, so analyzers without a checkout can report the commit they read
 * without failing over it.
 */
export async function defaultBranchHead(
  forge: Pick<GitForge, 'getRepository' | 'headCommit' | 'listCommits'>,
  repo: string,
): Promise<string | undefined> {
  try {
    if (forge.headCommit) return await forge.headCommit(repo)
    if (!forge.listCommits) return undefined
    const { defaultBranch } = await forge.getRepository(repo)
    return (await forge.listCommits(repo, { ref: defaultBranch, limit: 1 }))[0]?.sha
  } catch {
    return undefined
  }
}
