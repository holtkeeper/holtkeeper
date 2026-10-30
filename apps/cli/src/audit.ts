import { resolve } from 'node:path'

import {
  type AuditReport,
  type Fixer,
  type Scanner,
  type Traits,
  allowlistSchema,
  runAudit,
} from '@holtkeeper/vuln'
import { goFixer } from '@holtkeeper/vuln-go'
import { jsFixer } from '@holtkeeper/vuln-js'
import { osvFixer, osvScanner } from '@holtkeeper/vuln-osv'
import { z } from 'zod'

/** Scanner and fixers the `audit` command uses; tests replace them. */
export interface AuditServices {
  scanner: Scanner
  fixers: Fixer[]
}

/** osv-scanner finds; `osv-scanner fix` gets the first try, ecosystem fixers handle the rest. */
export const defaultAuditServices = (): AuditServices => ({
  scanner: osvScanner(),
  fixers: [osvFixer(), jsFixer(), goFixer()],
})

export class UsageError extends Error {
  override name = 'UsageError'
}

/** Parses `key=value` pairs; `true`, `false` and numbers become their own types. */
export function parseTraits(pairs: readonly string[]): Traits {
  const traits: Traits = {}
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator < 1) throw new UsageError(`trait must look like key=value, got "${pair}"`)
    const value = pair.slice(separator + 1)
    traits[pair.slice(0, separator)] =
      value === 'true'
        ? true
        : value === 'false'
          ? false
          : value !== '' && Number.isFinite(Number(value))
            ? Number(value)
            : value
  }
  return traits
}

async function readAllowlist(file: string | undefined) {
  if (!file) return []
  const handle = Bun.file(resolve(file))
  if (!(await handle.exists())) throw new UsageError(`allowlist not found: ${file}`)
  const result = allowlistSchema.safeParse(await handle.json())
  if (!result.success)
    throw new UsageError(`invalid allowlist ${file}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export interface AuditCommandOptions {
  dir: string
  fix: boolean
  allowlist?: string
  traits: Traits
}

export async function auditCommand(options: AuditCommandOptions, services: AuditServices) {
  return runAudit({
    dir: resolve(options.dir),
    scanner: services.scanner,
    fixers: options.fix ? services.fixers : [],
    allowlist: await readAllowlist(options.allowlist),
    traits: options.traits,
  })
}

/** Plain-text rendering of a report, one line per item. */
export function formatReport(report: AuditReport): string {
  const lines = [
    `${report.scanner}: ${report.findings.length} vulnerable, ${report.ignored.length} allowlisted` +
      (report.fixes.length ? `, ${report.resolved.length} fixed` : ''),
  ]
  for (const f of report.findings) {
    const fix = f.fixedVersions[0] ? `fix ${f.fixedVersions[0]}` : 'no fix'
    lines.push(
      `  ${f.severity.padEnd(8)} ${f.package.name}@${f.package.version}  ${f.id}  ${f.source}  ${fix}`,
    )
  }
  for (const attempt of report.fixes) {
    const outcome = attempt.error
      ? `failed: ${attempt.error}`
      : `claimed ${attempt.fixed.length}/${attempt.requested.length}`
    lines.push(`fixer ${attempt.fixer} on ${attempt.source}: ${outcome}`)
    for (const note of attempt.notes) lines.push(`  ${note}`)
  }
  if (report.changedFiles.length) lines.push(`changed: ${report.changedFiles.join(', ')}`)
  for (const entry of report.expired)
    lines.push(`expired allowlist entry: ${entry.id} (${entry.expires})`)
  return lines.join('\n')
}

/** Posts a report to a Holtkeeper server and returns the URL of the stored run. */
export async function uploadReport(
  server: string,
  repo: string,
  report: AuditReport,
  startedAt: string,
  fetcher: typeof fetch,
): Promise<string> {
  const separator = repo.indexOf(':')
  if (separator < 1) throw new UsageError('--repo must look like <forge>:<path>')
  const base = server.replace(/\/+$/, '')
  const response = await fetcher(`${base}/api/audit-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repo: { forge: repo.slice(0, separator), path: repo.slice(separator + 1) },
      trigger: 'cli',
      startedAt,
      finishedAt: new Date().toISOString(),
      report,
    }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String(body.error)
        : response.statusText
    throw new UsageError(`upload failed (${response.status}): ${message}`)
  }
  const id =
    typeof body === 'object' &&
    body !== null &&
    'run' in body &&
    typeof body.run === 'object' &&
    body.run !== null &&
    'id' in body.run
      ? String(body.run.id)
      : ''
  return `${base}/audits/${id}`
}
