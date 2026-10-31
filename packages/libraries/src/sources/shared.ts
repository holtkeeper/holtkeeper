import type {
  LibraryRecord,
  LibraryRef,
  LibrarySourceStatus,
  LibraryVersionRecord,
} from '@holtkeeper/store'

/** What a per-version source changed: its status and the version fields it found. */
export interface SourceOutcome {
  status: LibrarySourceStatus
  patch?: Partial<Pick<LibraryVersionRecord, 'api' | 'sourceArchive' | 'tag' | 'commit'>>
}

/** The library and version a source works on. */
export interface SourceTarget {
  library: LibraryRecord
  version: LibraryVersionRecord
  now: () => Date
}

export const sourceStatus = (
  status: LibrarySourceStatus['status'],
  now: () => Date,
  message?: string,
): LibrarySourceStatus => ({
  status,
  at: now().toISOString(),
  ...(message ? { message: message.slice(0, 500) } : {}),
})

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** `<ecosystem>:<name>`, the `library` tag of artifacts and the key of summaries. */
export const libraryKey = (ref: LibraryRef) => `${ref.ecosystem}:${ref.name}`

/** Tags of artifacts that belong to one library version. */
export const artifactTags = (ref: LibraryRef, version: string, content: string) => ({
  kind: 'library',
  library: libraryKey(ref),
  version,
  content,
})

/** A file name for artifacts, e.g. `npm/@scope/name/1.2.3/api.json`. */
export const artifactName = (ref: LibraryRef, version: string, file: string) =>
  `${ref.ecosystem}/${ref.name}/${version}/${file}`

export const refOf = (ref: LibraryRef): LibraryRef => ({ ecosystem: ref.ecosystem, name: ref.name })
