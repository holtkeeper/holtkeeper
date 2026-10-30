import type { ForgeDefinition, GitForge } from './types.ts'

/** Whether Holtkeeper must not change the repository at `repo` (full path on the forge). */
export type ReadOnlyCheck = (repo: string) => boolean | Promise<boolean>

/** Thrown instead of a write to a repository that is read-only for Holtkeeper. */
export class ReadOnlyRepositoryError extends Error {
  readonly repo: string
  readonly operation: string

  constructor(repo: string, operation: string) {
    super(`${repo} is read-only for Holtkeeper: ${operation} is not allowed`)
    this.name = 'ReadOnlyRepositoryError'
    this.repo = repo
    this.operation = operation
  }
}

const firstArgument = (args: readonly unknown[]) =>
  typeof args[0] === 'string' ? args[0] : undefined

const deployRepo = (scope: unknown): string | undefined => {
  if (typeof scope !== 'object' || scope === null) return undefined
  const repo: unknown = Reflect.get(scope, 'repo')
  return Reflect.get(scope, 'kind') === 'deploy' && typeof repo === 'string' ? repo : undefined
}

const writes: Record<string, (args: readonly unknown[]) => string | undefined> = {
  createBranch: firstArgument,
  deleteBranch: firstArgument,
  commit: firstArgument,
  createMergeRequest: firstArgument,
  updateMergeRequest: firstArgument,
  mergeMergeRequest: firstArgument,
  commentOnMergeRequest: firstArgument,
  playJob: firstArgument,
  retryJob: firstArgument,
  createTag: firstArgument,
  submitReview: firstArgument,
  replyToDiscussion: firstArgument,
  resolveDiscussion: firstArgument,
  registerSshKey: (args) =>
    typeof args[0] === 'object' && args[0] !== null
      ? deployRepo(Reflect.get(args[0], 'scope'))
      : undefined,
  enableDeployKey: (args) => deployRepo(args[1]),
  ensureWebhook: (args) => {
    const target = args[0]
    if (typeof target !== 'object' || target === null) return undefined
    const project: unknown = Reflect.get(target, 'project')
    return typeof project === 'string' ? project : undefined
  },
}

/**
 * `forge` with every change to a read-only repository rejected with `ReadOnlyRepositoryError`
 * before it reaches the forge: branches, commits, tags, merge requests, comments, reviews, threads,
 * pipeline jobs, deploy keys and project webhooks. Reads, user keys, group webhooks and removals of
 * keys and hooks pass through. Optional methods stay absent when `forge` lacks them.
 */
export function readOnlyForge(forge: GitForge, isReadOnly: ReadOnlyCheck): GitForge {
  return new Proxy(forge, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      const repoOf = typeof key === 'string' ? writes[key] : undefined
      if (!repoOf) return value.bind(target)
      return async (...args: unknown[]) => {
        const repo = repoOf(args)
        if (repo !== undefined && (await isReadOnly(repo)))
          throw new ReadOnlyRepositoryError(repo, String(key))
        return Reflect.apply(value, target, args)
      }
    },
  })
}

/** `definition` whose clients, also those of `withFetch` copies, go through `readOnlyForge`. */
export function readOnlyDefinition(
  definition: ForgeDefinition,
  isReadOnly: ReadOnlyCheck,
): ForgeDefinition {
  return {
    ...definition,
    create: () => readOnlyForge(definition.create(), isReadOnly),
    ...(definition.withFetch && {
      withFetch: (wrap) =>
        readOnlyDefinition(definition.withFetch?.(wrap) ?? definition, isReadOnly),
    }),
  }
}
