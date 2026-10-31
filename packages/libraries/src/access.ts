import type { LibraryEcosystem } from '@holtkeeper/store'

/** A library as tools name it; `ecosystem` defaults to `npm`. */
export interface LibraryQuery {
  package: string
  ecosystem?: LibraryEcosystem
}

/**
 * Who asks: `repo` (`forge:path`) picks the default version, the one that repository resolves;
 * `canRead` hides repositories the caller may not read from `usedBy` lists.
 */
export interface LibraryCaller {
  repo?: string
  canRead?: (repo: string) => boolean
}

/**
 * What agents ask about third-party libraries, as compact Markdown for a model. Every answer names
 * the versions it comes from and marks library, repository and issue text as third-party content.
 * Unknown libraries and versions are answered with a short explanation, never an exception;
 * `version` defaults to the caller repository's version, else the newest indexed one.
 */
export interface LibraryDocs {
  /** The indexed versions with roles, dates, deprecations and which repositories use them. */
  versions(query: LibraryQuery, caller?: LibraryCaller): Promise<string>
  /** Chunks matching `query`, best first; without `package`, over every library. */
  search(
    input: {
      package?: string
      ecosystem?: LibraryEcosystem
      version?: string
      query: string
      limit?: number
    },
    caller?: LibraryCaller,
  ): Promise<string>
  /** One document (by path) or one section of it (by heading); without `path`, the document list. */
  read(
    input: LibraryQuery & { version?: string; path?: string; heading?: string },
    caller?: LibraryCaller,
  ): Promise<string>
  /** Changelog sections and release notes in `(from, to]`, and migration sections for crossed majors. */
  changes(input: LibraryQuery & { from: string; to: string }): Promise<string>
  /** Issue digests and threads matching `query`, then live search hits when the index has few. */
  issues(
    input: LibraryQuery & { query: string; version?: string; limit?: number },
    caller?: LibraryCaller,
  ): Promise<string>
  /** A file listing (optionally under `path`) or one file of the version's source snapshot. */
  source(
    input: LibraryQuery & { version?: string; path?: string; start?: number; end?: number },
    caller?: LibraryCaller,
  ): Promise<string>
}
