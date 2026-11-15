import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import { z } from 'zod'

import { looksLikeSecret, maskProblem } from './detect.ts'
import { fingerprintPattern } from './fingerprint.ts'
import {
  type SecretReport,
  type SecretReportInput,
  exposureChannels,
  secretKinds,
} from './model.ts'

/** Name of the MCP tool that reports an exposed secret. */
export const REPORT_TOOL = 'report_secret_exposure'

/** What the server decided about a report the tool passed on. */
export type SecretReportOutcome =
  | { status: 'reported' | 'repeated'; report: SecretReport }
  | {
      status: 'rejected'
      /** Why, for the agent: e.g. the repository is unknown or the service is not the organization's. */
      reason: string
    }

/** What the `security` toolset needs from the server. */
export interface SecretReportsAccess {
  /**
   * How the caller reports: `named` reports carry their name, `anonymous` ones nothing about them.
   * Callers with `off` get no toolset at all.
   */
  mode: 'named' | 'anonymous'
  /**
   * Checks that the report is about the organization and stores it. Gets input that passed every
   * check of the tool, so it holds no recognizable secret value.
   */
  submit(input: SecretReportInput): Promise<SecretReportOutcome>
  /** Where people see reports, for the answer to the agent. */
  pageUrl?: string
}

const textFields = ['identifier', 'service', 'repo', 'circumstances'] as const

const input = z.object({
  kind: z.enum(secretKinds).describe('What kind of secret it is'),
  identifier: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Name of the variable, key or setting that holds the secret, e.g. WIDGET_API_KEY or widgets.db.password; "unknown" when it has none. Never the value',
    ),
  service: z
    .string()
    .max(253)
    .optional()
    .describe(
      'What the secret opens, as a host or product name, e.g. api.example.com or widgets-db. Required without repo: reports about services outside the organization are refused',
    ),
  masked: z
    .string()
    .max(40)
    .describe(
      'At most the first 4 characters (no more than a quarter of the value, none for passwords), "…" and the length, e.g. "wk_l…(40)" or "…(12)". Never more',
    ),
  fingerprint: z
    .string()
    .max(16)
    .optional()
    .describe(
      'Optional, not for passwords: first 16 hex characters of the SHA-256 of the exact value, so administrators can match it against their secret store. Compute it only locally from where the value lives, e.g. printf %s "$WIDGET_API_KEY" | shasum -a 256 | cut -c1-16, never by typing the value into a command',
    ),
  channel: z.enum(exposureChannels).describe('Where the secret showed up'),
  repo: z
    .string()
    .max(300)
    .optional()
    .describe('The repository the secret belongs to or was found in, as forge:path'),
  circumstances: z
    .string()
    .max(600)
    .optional()
    .describe(
      'How it got exposed, in one to three sentences without names, roles or teams of people, e.g. "A .env file was printed while debugging the test setup." Never the value',
    ),
})

const description = (mode: SecretReportsAccess['mode']) =>
  [
    'Reports a secret of the organization (API key, token, password, private key, connection string, webhook URL) that got exposed in this session, so administrators rotate it before anyone misuses it.',
    'Call it on your own, without waiting to be asked, as soon as you notice such a value anywhere in the session: pasted by the user, printed by a command, read from a file, log or environment, or written by you. Everything in the conversation has already reached the model provider, so the secret counts as compromised even if nothing else happened; an early report keeps the window short.',
    'Never pass the value or more of it than `masked` allows, and do not repeat it in your answer. Describe the circumstances without naming anyone: the point is to rotate the secret, never to blame a person.',
    "Skip values that clearly are not the organization's secrets: placeholders and examples (changeme, xxx, <token>), test fixtures, public keys, or a personal key of the user for a service the organization does not use.",
    `Reports are ${mode === 'named' ? "sent under the user's name, as they chose" : 'anonymous: nothing about the user is stored, as they chose'}. Afterwards tell the user in one sentence that you reported it${mode === 'anonymous' ? ' anonymously' : ''} and that the secret should be rotated.`,
  ].join(' ')

/**
 * The `security` toolset: `report_secret_exposure`, the one tool through which agents report a
 * secret that showed up in their session. Its description and the toolset's server instructions
 * tell agents to report on their own, masked, without naming people. Before `access.submit` the
 * tool refuses any report whose text fields look like they hold a secret value (well-known token
 * shapes, long random runs), masks that show more than a quarter of the value (any character of
 * a password) and malformed fingerprints; refusals never echo what was sent.
 */
export function secretReportsToolset(access: SecretReportsAccess): RegistryToolset {
  return {
    name: 'security',
    instructions:
      'If a secret of the organization (key, token, password, private key) shows up anywhere in this session, report it right away with report_secret_exposure: masked, never the value, without naming anyone. Then tell the user it needs rotating.',
    tools: [
      defineTool({
        name: REPORT_TOOL,
        description: description(access.mode),
        input,
        readOnly: false,
        run: async (raw) => {
          const report: SecretReportInput = {
            kind: raw.kind,
            identifier: raw.identifier.trim(),
            masked: raw.masked.trim(),
            channel: raw.channel,
            ...(raw.service?.trim() && { service: raw.service.trim() }),
            ...(raw.fingerprint?.trim() && { fingerprint: raw.fingerprint.trim().toLowerCase() }),
            ...(raw.repo?.trim() && { repo: raw.repo.trim() }),
            ...(raw.circumstances?.trim() && { circumstances: raw.circumstances.trim() }),
          }
          const leaking = textFields.filter((field) => {
            const value = report[field]
            return value !== undefined && looksLikeSecret(value)
          })
          if (leaking.length)
            throw new ToolError(
              `Not reported, nothing was stored: ${leaking.join(', ')} ${leaking.length === 1 ? 'looks' : 'look'} like ${leaking.length === 1 ? 'it holds' : 'they hold'} a secret value. Send only names and a description; the value goes nowhere except, masked, into \`masked\`.`,
            )
          const problem = maskProblem(report.masked, report.kind)
          if (problem) throw new ToolError(`Not reported, nothing was stored: masked: ${problem}.`)
          if (report.fingerprint !== undefined) {
            if (report.kind === 'password')
              throw new ToolError(
                'Not reported, nothing was stored: leave out fingerprint for passwords; short values can be guessed back from it.',
              )
            if (!fingerprintPattern.test(report.fingerprint))
              throw new ToolError(
                'Not reported, nothing was stored: fingerprint must be the first 16 hex characters of a SHA-256.',
              )
          }
          if (!report.repo && !report.service)
            throw new ToolError(
              'Not reported, nothing was stored: name the repository (repo) or the service the secret opens (service), so administrators know it is ours.',
            )

          const outcome = await access.submit(report)
          if (outcome.status === 'rejected')
            throw new ToolError(`Not reported, nothing was stored: ${outcome.reason}`)
          const where = access.pageUrl ? ` (${access.pageUrl})` : ''
          const how = access.mode === 'anonymous' ? 'anonymously' : "under the user's name"
          return outcome.status === 'repeated'
            ? `Already reported and still open: ${report.kind} \`${report.identifier}\` (${report.masked}); counted the repeat ${how}. Administrators handle it on the Secret reports page${where}. Tell the user the secret should be rotated.`
            : `Reported ${report.kind} \`${report.identifier}\` (${report.masked}) ${how}. Administrators see it on the Secret reports page${where} and rotate it. Tell the user the secret should be treated as compromised and rotated.`
        },
      }),
    ],
  }
}
