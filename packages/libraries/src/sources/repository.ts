import type { LibraryChunk, LibraryStore } from '@holtkeeper/store'

import { readTarball } from '../archive.ts'
import { DownloadTooLargeError, type GitHubClient } from '../github/client.ts'
import { documentChunks } from '../markdown.ts'
import { encodeRef, githubPath } from '../tags.ts'
import type { ArchiveFiles } from '../types.ts'
import { type SourceOutcome, type SourceTarget, refOf, sourceStatus } from './shared.ts'

const markdown = /\.(md|mdx|markdown)$/i
const topDoc =
  /^(readme|changelog|changes|history|migration|migrating|upgrading|upgrade)(\.(md|mdx|markdown))?$/i
const changeDoc =
  /^(changelog|changes|history|migration|migrating|upgrading|upgrade)(\.(md|mdx|markdown))?$/i

/**
 * Whether a repository file (path from the repository root) is indexed: `llms.txt`,
 * `llms-full.txt`, Markdown under `docs/`, `website/docs/` and `examples/`, at the root and under
 * the package `directory`; the changelog and migration guides at the root; the README, changelog
 * and migration guides of `directory`. The root README is left to the package archive.
 */
export function keepRepositoryFile(path: string, directory?: string): boolean {
  const roots = directory ? ['', `${directory}/`] : ['']
  for (const root of roots) {
    if (root && !path.startsWith(root)) continue
    const rest = path.slice(root.length)
    if (/^llms(-full)?\.txt$/i.test(rest)) return true
    if (/^(docs|website\/docs|examples)\//.test(rest) && markdown.test(rest)) {
      if (rest.split('/').includes('node_modules')) return false
      return true
    }
    if (!rest.includes('/') && (root ? topDoc : changeDoc).test(rest)) return true
  }
  return false
}

const maxFiles = 500

/** Chunks of the kept files of a repository snapshot, in path order. */
export function repositoryChunks(
  target: SourceTarget,
  files: ArchiveFiles,
  url: (path: string) => string,
): Omit<LibraryChunk, 'versions'>[] {
  const ref = refOf(target.library)
  const decoder = new TextDecoder()
  return [...files.keys()]
    .toSorted()
    .slice(0, maxFiles)
    .flatMap((path) =>
      documentChunks(ref, 'repository', path, decoder.decode(files.get(path)), { url: url(path) }),
    )
    .slice(0, 6000)
}

/**
 * Source `repository`: docs of the library's GitHub repository at the version's tag or commit
 * (`gitRef`). `skipped` for other hosts, `missing` without a ref or without docs.
 */
export async function repositorySource(
  store: LibraryStore,
  github: GitHubClient,
  target: SourceTarget,
  gitRef: string | undefined,
  maxDownloadBytes = 100_000_000,
): Promise<SourceOutcome> {
  const repository = target.library.repository
  const path = githubPath(repository)
  if (!path) return { status: sourceStatus('skipped', target.now, 'not a GitHub repository') }
  if (!gitRef)
    return { status: sourceStatus('missing', target.now, 'no tag or commit for this version') }
  let files: ArchiveFiles
  try {
    const stream = await github.download(`/repos/${path}/tarball/${encodeRef(gitRef)}`, {
      maxBytes: maxDownloadBytes,
    })
    if (!stream) return { status: sourceStatus('missing', target.now, `no tarball at ${gitRef}`) }
    files = await readTarball(stream, {
      stripTop: true,
      keep: (file) => keepRepositoryFile(file, repository?.directory),
      maxTotalBytes: 20_000_000,
    })
  } catch (error) {
    if (error instanceof DownloadTooLargeError)
      return {
        status: sourceStatus('missing', target.now, `tarball at ${gitRef}: ${error.message}`),
      }
    throw error
  }
  const chunks = repositoryChunks(
    target,
    files,
    (file) => `https://github.com/${path}/blob/${gitRef}/${file}`,
  )
  await store.replaceChunks(refOf(target.library), target.version.version, 'repository', chunks)
  return {
    status: chunks.length
      ? sourceStatus('ok', target.now)
      : sourceStatus('missing', target.now, `no docs in the repository at ${gitRef}`),
  }
}
