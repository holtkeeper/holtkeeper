import { type ArtifactStore, zipArtifacts } from '@holtkeeper/artifacts'
import type { LibraryRef, LibraryStore } from '@holtkeeper/store'

import { readTarball } from '../archive.ts'
import type { GitHubClient } from '../github/client.ts'
import { encodeRef, githubPath, tagResolver } from '../tags.ts'
import { artifactName, artifactTags, errorText, refOf, sourceStatus } from './shared.ts'

/** Outcome of a source snapshot request: the ZIP artifact id, or why there is none. */
export interface SnapshotResult {
  id?: string
  message?: string
}

/** Makes (or finds) the source snapshot of one version. */
export type SourceSnapshot = (ref: LibraryRef, version: string) => Promise<SnapshotResult>

export interface SourceSnapshotOptions {
  store: LibraryStore
  artifacts: ArtifactStore
  github?: GitHubClient
  /** Repositories larger than this (GitHub's `size`) are not snapshotted. Default 200 MB. */
  maxRepositoryKb?: number
  /** Files kept up to this total. Default 100 MB. */
  maxBytes?: number
  /** Files larger than this are left out. Default 1 MB. */
  maxFileBytes?: number
  now?: () => Date
}

const skippedFolder = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage'])

/**
 * Source `source`: on first request, the version's GitHub tarball at its tag (or commit) as a ZIP
 * artifact of its text files, recorded as `sourceArchive` with status `source`. For a package in
 * a repository folder only that folder and the root files are kept. Later requests return the
 * stored artifact. Answers with a `message` instead of throwing.
 */
export function sourceSnapshots(options: SourceSnapshotOptions): SourceSnapshot {
  const now = options.now ?? (() => new Date())
  const maxKb = options.maxRepositoryKb ?? 200_000
  const resolve = options.github ? tagResolver(options.github) : undefined
  const pending = new Map<string, Promise<SnapshotResult>>()

  const make = async (ref: LibraryRef, version: string): Promise<SnapshotResult> => {
    const library = await options.store.getLibrary(ref)
    const record = await options.store.getVersion(ref, version)
    if (!library || !record) return { message: `${ref.name}@${version} is not indexed` }
    if (record.sourceArchive && (await options.artifacts.has(record.sourceArchive)))
      return { id: record.sourceArchive }
    const repository = library.repository
    const path = githubPath(repository)
    const save = async (
      result: SnapshotResult,
      status: 'ok' | 'missing' | 'failed' | 'skipped',
    ) => {
      const latest = (await options.store.getVersion(ref, version)) ?? record
      await options.store.putVersion({
        ...latest,
        ...(result.id ? { sourceArchive: result.id } : {}),
        sources: { ...latest.sources, source: sourceStatus(status, now, result.message) },
        updatedAt: now().toISOString(),
      })
      return result
    }
    if (!path || !repository)
      return save({ message: 'the source is only snapshotted from GitHub' }, 'skipped')
    if (!options.github || !resolve)
      return save({ message: 'no GitHub client configured' }, 'skipped')
    try {
      const info = await options.github.rest<{ size?: number }>(`/repos/${path}`)
      if ((info.data?.size ?? 0) > maxKb)
        return save({ message: `repository ${path} is too large to snapshot` }, 'skipped')
      const gitRef =
        record.tag ?? record.commit ?? (await resolve({ repository, name: ref.name, version })).ref
      if (!gitRef)
        return save({ message: `no tag or commit for ${ref.name}@${version}` }, 'missing')
      const bytes = await options.github.bytes(`/repos/${path}/tarball/${encodeRef(gitRef)}`)
      if (!bytes) return save({ message: `no tarball at ${gitRef}` }, 'missing')
      const directory = repository.directory
      const files = await readTarball(bytes, {
        stripTop: true,
        maxFileBytes: options.maxFileBytes ?? 1_000_000,
        maxTotalBytes: options.maxBytes ?? 100_000_000,
        keep: (file) =>
          !file.split('/').some((part) => skippedFolder.has(part)) &&
          (!directory || !file.includes('/') || file.startsWith(`${directory}/`)),
      })
      if (!files.size) return save({ message: `no text files at ${gitRef}` }, 'missing')
      const zip = zipArtifacts([...files].map(([file, data]) => ({ path: file, data })))
      const { id } = await options.artifacts.put(zip, {
        contentType: 'application/zip',
        name: artifactName(refOf(ref), version, 'source.zip'),
        tags: artifactTags(ref, version, 'source'),
      })
      return save({ id }, 'ok')
    } catch (error) {
      return save({ message: `snapshot failed: ${errorText(error)}` }, 'failed')
    }
  }

  return (ref, version) => {
    const key = `${ref.ecosystem}:${ref.name}@${version}`
    let job = pending.get(key)
    if (!job) {
      job = make(ref, version).finally(() => pending.delete(key))
      pending.set(key, job)
    }
    return job
  }
}
