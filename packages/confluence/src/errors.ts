/** A non-2xx or malformed answer from Confluence. The message never contains credentials. */
export class ConfluenceApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ConfluenceApiError'
    this.status = status
  }
}

/**
 * The page is not at the version the caller expected; nothing was written. Carries
 * `code: 'version_conflict'` and `expectedVersion`/`actualVersion`, so `isVersionConflict` of
 * `@holtkeeper/tracker` recognizes it.
 */
export class VersionConflictError extends Error {
  readonly code = 'version_conflict'
  readonly ref: string
  readonly expected: number
  readonly actual: number
  readonly expectedVersion: number
  readonly actualVersion: number

  constructor(ref: string, expected: number, actual: number) {
    super(`page ${ref} is at version ${actual}, expected ${expected}`)
    this.name = 'VersionConflictError'
    this.ref = ref
    this.expected = expected
    this.actual = actual
    this.expectedVersion = expected
    this.actualVersion = actual
  }
}

/** The page's markers for a section are unusable (duplicated, unpaired or not at block level). */
export class MarkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarkerError'
  }
}

/** The input cannot be turned into storage format (bad reference, marker id or content). */
export class ConfluenceInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfluenceInputError'
  }
}
