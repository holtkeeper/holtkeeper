import type { Severity } from '@holtkeeper/vuln'
import { z } from 'zod'

/** Setting key of the urgent vulnerability alerts. */
export const securityAlertsSettingKey = 'security.alerts'

const severities = ['critical', 'high', 'medium', 'low', 'unknown'] as const satisfies Severity[]

const channelId = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{6,20}$/, 'a Slack channel id such as C0123ABCD (channel details › About)')

/**
 * Where urgent vulnerabilities are reported and which advisories are triaged. Every field has a
 * default, so `{}` is valid and reports nothing until `channels` names one.
 */
export const securityAlertsSchema = z.object({
  channels: z.array(channelId).max(20).default([]).describe('Slack channel ids, e.g. C0123ABCD'),
  severities: z
    .array(z.enum(severities))
    .max(severities.length)
    .default(['critical', 'unknown'])
    .describe('Severities the AI triages; known malicious packages are reported at any severity'),
  windowMinutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .default(30)
    .describe(
      'How long a new urgent advisory waits for audits of other repositories before it is posted',
    ),
  language: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe('Language of the AI explanation; default English'),
})

/** A parsed `security.alerts` value. */
export type SecurityAlertsSettings = z.output<typeof securityAlertsSchema>

/** `security.alerts` with defaults; a value that does not parse reports nothing. */
export const securityAlertsSettings = (value: unknown): SecurityAlertsSettings =>
  securityAlertsSchema.safeParse(value ?? {}).data ?? securityAlertsSchema.parse({})

/** The `security.alerts` setting for the settings registry; one value for every repository. */
export const securityAlertsDefinition = {
  key: securityAlertsSettingKey,
  label: 'Urgent vulnerability alerts',
  description:
    'Slack channels that get a message for every vulnerability in a dependency that needs a reaction now: malicious packages, remote code execution and the like.',
  section: 'Audit',
  global: true,
  default: securityAlertsSchema.parse({}),
  schema: securityAlertsSchema,
  help: `Picks the vulnerabilities that cannot wait out of the newest audits of every repository and posts them to Slack, one message per advisory and package with every affected repository listed.

- Known malicious packages (OSV \`MAL-\` advisories, GitHub malware advisories) are always reported, whatever their severity.
- Other advisories of the listed **severities** (default \`critical\` and \`unknown\`) are judged once by the AI (tier \`main\`, automatic work under the AI budget) from the advisory text, its CVSS vectors and CWEs: urgent are remote code execution, stolen or modified code and secrets, authentication bypass on servers and the like; build-time issues and attacks that need the code to be compromised already are not.
- **channels**: Slack channel ids, e.g. \`C0123ABCD\` (channel details › About). Invite the app first; it needs the \`chat:write\` scope. No channels, no alerts.
- **windowMinutes** (default 30): a new advisory waits this long for audits of other repositories, so one message names them all. Repositories found later are added to the message and named in its thread; when no repository has it any more the message is marked resolved.
- **language**: of the AI explanation, e.g. \`Russian\`; default English.

Allowlisted findings never alert.`,
}
