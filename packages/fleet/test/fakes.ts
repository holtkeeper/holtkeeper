import type { GitForge, ListFilesOptions, Repository, TreeEntry } from '@holtkeeper/forge'

import type { FleetForge } from '../src/analyze.ts'
import type { VersionRegistry } from '../src/registry.ts'
import type { Ecosystem } from '../src/types.ts'

/** In-memory forge: files by repository path, then file path. */
export function fakeForge(
  files: Record<string, Record<string, string>>,
  options: { archived?: string[]; broken?: string[]; listing?: boolean } = {},
): FleetForge & { reads: string[]; listings: string[] } {
  const reads: string[] = []
  const listings: string[] = []
  return {
    reads,
    listings,
    ...(options.listing
      ? {
          async listFiles(path: string, query: ListFilesOptions = {}) {
            listings.push(`${path}:${query.path ?? ''}${query.recursive ? '/**' : ''}`)
            return listTree(Object.keys(files[path] ?? {}), query)
          },
        }
      : {}),
    async getRepository(path): Promise<Repository> {
      if (options.broken?.includes(path) || !(path in files)) throw new Error(`404 ${path}`)
      return {
        path,
        name: path.split('/').at(-1) ?? path,
        defaultBranch: 'main',
        webUrl: `https://git.test/${path}`,
        cloneUrl: `https://git.test/${path}.git`,
        archived: options.archived?.includes(path) ?? false,
      }
    },
    async readFile(path, file, ref) {
      reads.push(`${path}:${file}${ref ? `@${ref}` : ''}`)
      return files[path]?.[file]
    },
  }
}

export function fakeRegistry(
  latest: Record<string, string>,
): VersionRegistry & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async latest(ecosystem: Ecosystem, name: string) {
      calls.push(`${ecosystem}:${name}`)
      return latest[`${ecosystem}:${name}`]
    },
  }
}

const unsupported = () => Promise.reject(new Error('not used by the fleet analysis'))

/** `fakeForge` with every other `GitForge` method rejecting, for code typed against `GitForge`. */
export function fakeGitForge(files: Record<string, Record<string, string>>): GitForge {
  const forge = fakeForge(files)
  return {
    kind: 'fake',
    getRepository: forge.getRepository,
    readFile: forge.readFile,
    ...(forge.listFiles ? { listFiles: forge.listFiles } : {}),
    async *listRepositories() {},
    createBranch: unsupported,
    deleteBranch: unsupported,
    commit: unsupported,
    findMergeRequest: unsupported,
    createMergeRequest: unsupported,
    updateMergeRequest: unsupported,
    mergeMergeRequest: unsupported,
    commentOnMergeRequest: unsupported,
    listPipelines: unsupported,
    listJobs: unsupported,
    playJob: unsupported,
    retryJob: unsupported,
    createTag: unsupported,
  }
}

/** Entries of a tree made of `files`, as `GitForge.listFiles` returns them. */
function listTree(
  files: string[],
  { path = '', recursive = false, limit = 10_000 }: ListFilesOptions,
): TreeEntry[] {
  const entries = new Map<string, TreeEntry>()
  for (const file of files) {
    const parts = file.split('/')
    parts.forEach((_, index) => {
      const entry = parts.slice(0, index + 1).join('/')
      entries.set(entry, { path: entry, type: index === parts.length - 1 ? 'file' : 'dir' })
    })
  }
  const prefix = path ? `${path}/` : ''
  return [...entries.values()]
    .filter((entry) => entry.path.startsWith(prefix))
    .filter((entry) => recursive || !entry.path.slice(prefix.length).includes('/'))
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .slice(0, limit)
}
