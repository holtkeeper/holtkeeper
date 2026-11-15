/** What kind of secret was exposed. */
export const secretKinds = [
  'api-key',
  'token',
  'password',
  'private-key',
  'certificate',
  'connection-string',
  'webhook-url',
  'other',
] as const

export type SecretKind = (typeof secretKinds)[number]

/** Where the secret showed up. */
export const exposureChannels = [
  'chat',
  'command-output',
  'file-read',
  'commit',
  'log',
  'issue-or-merge-request',
  'other',
] as const

export type ExposureChannel = (typeof exposureChannels)[number]

/**
 * How a person's agent reports exposed secrets: `named` under the person's name, `anonymous`
 * with nothing that points to them, `off` not at all (the tool is not even offered).
 */
export const reportingModes = ['named', 'anonymous', 'off'] as const

export type ReportingMode = (typeof reportingModes)[number]

/** What a token reports with until its owner picks something else. */
export const DEFAULT_REPORTING_MODE: ReportingMode = 'named'

/** Where a report stands; `new` and `acknowledged` are open, the rest closed. */
export const reportStatuses = ['new', 'acknowledged', 'rotated', 'false-positive'] as const

export type SecretReportStatus = (typeof reportStatuses)[number]

/** Whether a report still needs someone's attention. */
export const isOpenStatus = (status: SecretReportStatus) =>
  status === 'new' || status === 'acknowledged'

/** The person behind a `named` report. */
export interface SecretReporter {
  id: string
  name: string
}

/** What an agent sends, already validated: never the secret itself. */
export interface SecretReportInput {
  kind: SecretKind
  /** Name of the variable, key or setting that holds the secret, e.g. `WIDGET_API_KEY`. */
  identifier: string
  /** The service the secret opens, as a host or a name. */
  service?: string
  /** At most the first few characters and the length, e.g. `wk_l…(40)`. */
  masked: string
  /** First 16 hex characters of the SHA-256 of the exact value. */
  fingerprint?: string
  channel: ExposureChannel
  /** Repository as `forge:path`. */
  repo?: string
  /** How it happened, without names of people. */
  circumstances?: string
}

/**
 * A stored report. It holds no secret value and, unless `reporter` is set, nothing about who sent
 * it: anonymous reports keep a time moved back by up to 10 minutes.
 */
export interface SecretReport extends SecretReportInput {
  id: string
  status: SecretReportStatus
  /** Exact for named reports; moved back by up to 10 minutes, to the minute, for anonymous ones. */
  reportedAt: string
  /** Only on named reports. */
  reporter?: SecretReporter
  /** How many more times the same exposure was reported while the report was open. */
  repeats: number
  /** What people did about it. */
  note?: string
  updatedAt?: string
  /** Who changed the status or note last (an administrator, never the reporter). */
  updatedBy?: string
}
