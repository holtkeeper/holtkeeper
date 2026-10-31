import type { GitHubClient } from '../src/github/client.ts'

/** A gzipped tarball of `files`, every path under `top/`. */
export async function tarball(top: string, files: Record<string, string>): Promise<Uint8Array> {
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [`${top}/${path}`, text]),
  )
  return Bun.gzipSync(await new Bun.Archive(entries).bytes())
}

/** A `GitHubClient` answering REST paths from `rest` (pages chained by `next`) and downloads from `bytes`; records calls. */
export function fakeGitHub(
  rest: Record<string, unknown>,
  bytes: Record<string, Uint8Array> = {},
  next: Record<string, string> = {},
): GitHubClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    authenticated: true,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- mirrors GitHubClient.rest
    async rest<T>(path: string) {
      calls.push(path)
      if (!(path in rest)) return { status: 404, data: undefined }
      const following = next[path]
      return { status: 200, data: rest[path] as T, ...(following ? { next: following } : {}) }
    },
    async bytes(path) {
      calls.push(path)
      return bytes[path]
    },
    async graphql() {
      throw new Error('no GraphQL in tests')
    },
  }
}
