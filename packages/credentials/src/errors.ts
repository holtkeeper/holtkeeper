/** Thrown when no credential has the requested id. */
export class CredentialNotFoundError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`credential ${id} not found`)
    this.name = 'CredentialNotFoundError'
    this.id = id
  }
}

/** Thrown when create or update input is invalid. `issues` lists every problem as `field: message`. */
export class CredentialInputError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid credential: ${issues.join('; ')}`)
    this.name = 'CredentialInputError'
    this.issues = issues
  }
}
