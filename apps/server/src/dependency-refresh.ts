import type { BranchPushedEvent, GitForge } from '@holtkeeper/forge'

/** File names of the manifests and lockfiles the `usages` and `fleet` analyses read. */
const dependencyFiles: ReadonlySet<string> = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'go.mod',
  'go.sum',
  'go.work',
])

/** Whether `path` (at any depth) is one of `dependencyFiles`. */
export const isDependencyFile = (path: string) => dependencyFiles.has(path.split('/').at(-1) ?? '')

/**
 * Whether a push changed a manifest or lockfile: from the paths the event lists, else from the
 * forge's comparison of `before` and `sha`. `undefined` when neither can tell (a new branch, a
 * forge without `compareCommits`, a failed comparison).
 */
export async function pushChangesDependencies(
  event: BranchPushedEvent,
  forge: Pick<GitForge, 'compareCommits'> | undefined,
): Promise<boolean | undefined> {
  if (event.files) return event.files.some(isDependencyFile)
  if (!event.before || !forge?.compareCommits) return undefined
  try {
    const files = await forge.compareCommits(event.repo.path, event.before, event.sha)
    return files.some((file) => isDependencyFile(file.newPath) || isDependencyFile(file.oldPath))
  } catch {
    return undefined
  }
}

/** The repository's default branch: the event's, else the forge's; `undefined` when unknown. */
export async function defaultBranchOf(
  event: BranchPushedEvent,
  forge: Pick<GitForge, 'getRepository'> | undefined,
): Promise<string | undefined> {
  if (event.defaultBranch) return event.defaultBranch
  try {
    return (await forge?.getRepository(event.repo.path))?.defaultBranch
  } catch {
    return undefined
  }
}
