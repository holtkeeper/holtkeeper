import { scopeSchema } from '@holtkeeper/access'
import type { RotationPolicy } from '@holtkeeper/store'

import { CredentialInputError } from './errors.ts'
import type { CreateCredentialInput, UpdateCredentialInput } from './types.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

function text(value: unknown, field: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  issues.push(`${field}: must be a non-empty string`)
  return undefined
}

function url(value: unknown, issues: string[]): string | undefined {
  const raw = text(value, 'url', issues)
  if (raw === undefined) return undefined
  if (!URL.canParse(raw) || !['http:', 'https:'].includes(new URL(raw).protocol)) {
    issues.push('url: must be an http(s) URL')
    return undefined
  }
  return raw
}

function timestamp(value: unknown, field: string, issues: string[]): string | undefined {
  const date = typeof value === 'string' ? new Date(value) : undefined
  if (date && !Number.isNaN(date.getTime())) return date.toISOString()
  issues.push(`${field}: must be an ISO 8601 date`)
  return undefined
}

/** Largest serialized `options` a credential may carry. */
export const MAX_OPTIONS_BYTES = 16_384

function options(value: unknown, issues: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push('options: must be an object')
    return undefined
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    issues.push('options: must be JSON')
    return undefined
  }
  if (new TextEncoder().encode(serialized).length > MAX_OPTIONS_BYTES) {
    issues.push(`options: must be at most ${MAX_OPTIONS_BYTES} bytes as JSON`)
    return undefined
  }
  const copy: unknown = JSON.parse(serialized)
  return isRecord(copy) ? copy : undefined
}

function rotation(value: unknown, issues: string[]): RotationPolicy | undefined {
  if (!isRecord(value)) {
    issues.push('rotation: must be an object')
    return undefined
  }
  const { enabled, daysBefore, lifetimeDays } = value
  if (typeof enabled !== 'boolean' || !isPositiveInt(daysBefore) || !isPositiveInt(lifetimeDays)) {
    if (typeof enabled !== 'boolean') issues.push('rotation.enabled: must be a boolean')
    if (!isPositiveInt(daysBefore)) issues.push('rotation.daysBefore: must be a positive integer')
    if (!isPositiveInt(lifetimeDays))
      issues.push('rotation.lifetimeDays: must be a positive integer')
    return undefined
  }
  // A new token would be due again immediately and rotate on every scheduler run.
  if (daysBefore >= lifetimeDays) {
    issues.push('rotation.daysBefore: must be less than rotation.lifetimeDays')
    return undefined
  }
  return { enabled, daysBefore, lifetimeDays }
}

/**
 * Validates and normalizes credential input: trims strings, normalizes timestamps to ISO 8601 UTC
 * and drops unknown fields. With `partial`, absent fields are allowed and stay absent.
 * Throws `CredentialInputError` listing every problem.
 */
export function parseCredentialInput(input: unknown, partial: true): UpdateCredentialInput
export function parseCredentialInput(input: unknown, partial?: false): CreateCredentialInput
export function parseCredentialInput(input: unknown, partial = false): UpdateCredentialInput {
  if (!isRecord(input)) throw new CredentialInputError(['input: must be an object'])
  const issues: string[] = []
  const out: UpdateCredentialInput = {}
  const has = (key: string) => input[key] !== undefined
  const required = (key: string) => {
    if (has(key)) return true
    if (!partial) issues.push(`${key}: required`)
    return false
  }

  if (required('name')) out.name = text(input.name, 'name', issues)
  if (required('kind')) out.kind = text(input.kind, 'kind', issues)
  if (required('url')) out.url = url(input.url, issues)
  if (required('secret')) {
    if (typeof input.secret === 'string' && input.secret.length > 0) out.secret = input.secret
    else issues.push('secret: must be a non-empty string')
  }
  if (required('scope')) {
    const scope = scopeSchema.safeParse(input.scope)
    if (scope.success) out.scope = scope.data
    else
      issues.push(
        ...scope.error.issues.map(
          (issue) => `${['scope', ...issue.path].join('.')}: ${issue.message}`,
        ),
      )
  }
  if (has('expiresAt')) out.expiresAt = timestamp(input.expiresAt, 'expiresAt', issues)
  if (has('rotation')) out.rotation = rotation(input.rotation, issues)
  if (has('options')) out.options = options(input.options, issues)

  if (issues.length > 0) throw new CredentialInputError(issues)
  return out
}
