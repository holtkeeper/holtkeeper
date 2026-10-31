import type {
  LibraryEcosystem,
  LibraryRef,
  LibraryRepository,
  LibraryVersionRole,
} from '@holtkeeper/store'

/** One repository resolving one library to one version, from `usages` or `fleet` records. */
export interface LibraryUse extends LibraryRef {
  version: string
  /** `forge:path`. */
  repo: string
}

/** A published version as the registry lists it. */
export interface PublishedVersion {
  version: string
  publishedAt?: string
  deprecated?: string
  /** Commit the version was published from (npm `gitHead`). */
  commit?: string
}

/** Registry metadata of one library. */
export interface PublishedLibrary extends LibraryRef {
  description?: string
  homepage?: string
  repository?: LibraryRepository
  latest?: string
  versions: PublishedVersion[]
}

/** Files of an unpacked archive by relative path, without the archive's top folder. */
export type ArchiveFiles = Map<string, Uint8Array>

/** A package registry: npm, the Go module proxy, or a fake in tests. */
export interface LibraryRegistry {
  /** `undefined` when the registry does not know the library. */
  library(ref: LibraryRef): Promise<PublishedLibrary | undefined>
  /** The published archive of one version, unpacked; `undefined` when it does not exist. */
  archive(ref: LibraryRef, version: string): Promise<ArchiveFiles | undefined>
}

/** The indexed versions of one library with why each is kept. */
export interface MatrixVersion {
  version: string
  roles: LibraryVersionRole[]
  usedBy: string[]
}

/** Settings of the indexer, from the scoped `libraries` setting. */
export interface LibraryIndexSettings {
  enabled: boolean
  /** Globs of library names (`@types/*`, `github.com/acme/**`) never indexed. */
  exclude: string[]
  /** Globs indexed even when no repository uses them. */
  include: string[]
  /** Versions kept per library, most important roles first. */
  maxVersions: number
  /** Index `first` releases of crossed majors. */
  firstOfMajor: boolean
  sources: {
    repository: boolean
    releases: boolean
    issues: boolean
    site: boolean
  }
  /** Days a version stays after leaving the matrix. */
  graceDays: number
  /** Libraries indexed at the same time. */
  concurrency: number
}

export const defaultLibraryIndexSettings: LibraryIndexSettings = {
  enabled: true,
  exclude: ['@types/*'],
  include: [],
  maxVersions: 8,
  firstOfMajor: true,
  sources: { repository: true, releases: true, issues: true, site: false },
  graceDays: 28,
  concurrency: 3,
}

export type { LibraryEcosystem, LibraryRef }
