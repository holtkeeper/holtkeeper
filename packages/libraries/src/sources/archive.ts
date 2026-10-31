import type { LibraryChunk, LibraryRef, LibraryStore } from '@holtkeeper/store'

import { documentChunks } from '../markdown.ts'
import type { ArchiveFiles } from '../types.ts'
import { type SourceOutcome, type SourceTarget, refOf, sourceStatus } from './shared.ts'

const markdownFile = /\.(md|mdx|markdown)$/i
const skippedDoc =
  /^(licen[cs]e|notice|security|code_of_conduct|contributing|authors|funding|third[-_]party[-_]notices?)([.-]|$)/i

/** Whether a file of a package archive is documentation worth indexing. */
export function isArchiveDoc(path: string): boolean {
  const parts = path.split('/')
  const base = parts.at(-1) ?? ''
  if (parts.some((part) => part === 'node_modules' || part === 'test' || part === '__tests__'))
    return false
  if (skippedDoc.test(base)) return false
  if (/^llms(-full)?\.txt$/i.test(base)) return true
  return markdownFile.test(base)
}

/** URL of a file of a published version, where the ecosystem has a file browser for packages. */
export function archiveFileUrl(ref: LibraryRef, version: string, path: string): string | undefined {
  return ref.ecosystem === 'npm' ? `https://unpkg.com/${ref.name}@${version}/${path}` : undefined
}

const maxDocs = 300
const maxChunks = 4000

/** Chunks of every documentation file of a package archive, in path order. */
export function archiveChunks(
  ref: LibraryRef,
  version: string,
  files: ArchiveFiles,
): Omit<LibraryChunk, 'versions'>[] {
  const decoder = new TextDecoder()
  const paths = [...files.keys()].filter(isArchiveDoc).toSorted().slice(0, maxDocs)
  const chunks = paths.flatMap((path) => {
    const url = archiveFileUrl(ref, version, path)
    return documentChunks(ref, 'archive', path, decoder.decode(files.get(path)), url ? { url } : {})
  })
  return chunks.slice(0, maxChunks)
}

/** Source `archive`: the README, changelog, migration guides and docs a package ships. */
export async function archiveSource(
  store: LibraryStore,
  target: SourceTarget,
  files: ArchiveFiles | undefined,
): Promise<SourceOutcome> {
  if (!files) return { status: sourceStatus('missing', target.now, 'no archive') }
  const ref = refOf(target.library)
  const chunks = archiveChunks(ref, target.version.version, files)
  await store.replaceChunks(ref, target.version.version, 'archive', chunks)
  return {
    status: chunks.length
      ? sourceStatus('ok', target.now)
      : sourceStatus('missing', target.now, 'no documentation files in the archive'),
  }
}
