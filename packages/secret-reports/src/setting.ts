import { z } from 'zod'

/** Setting key of secret reports. */
export const secretReportsSettingKey = 'security.secretReports'

const channelId = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{6,20}$/, 'a Slack channel id such as C0123ABCD (channel details › About)')

/** Which reports are the organization's and who hears about new ones. Every field has a default. */
export const secretReportsSchema = z.object({
  services: z
    .array(z.string().trim().min(1).max(253))
    .max(500)
    .default([])
    .describe(
      "The organization's services: hosts (example.com covers its subdomains, *.example.com only them) and names such as widgets-db",
    ),
  channels: z
    .array(channelId)
    .max(20)
    .default([])
    .describe('Slack channel ids told about every new report, e.g. C0123ABCD'),
})

/** A parsed `security.secretReports` value. */
export type SecretReportsSettings = z.output<typeof secretReportsSchema>

/** `security.secretReports` with defaults; a value that does not parse counts as `{}`. */
export const secretReportsSettings = (value: unknown): SecretReportsSettings =>
  secretReportsSchema.safeParse(value ?? {}).data ?? secretReportsSchema.parse({})

/** The `security.secretReports` setting for the settings registry; one value for every repository. */
export const secretReportsDefinition = {
  key: secretReportsSettingKey,
  label: 'Secret reports',
  description:
    "Which services are the organization's, so agents' reports of exposed secrets about anything else are refused, and the Slack channels told about new reports.",
  section: 'Audit',
  global: true,
  default: secretReportsSchema.parse({}),
  schema: secretReportsSchema,
  help: `Agents connected over MCP report secrets that showed up in their sessions with \`report_secret_exposure\` (people choose per token whether they report under their name, anonymously or not at all). The server accepts a report only when it is about the organization:

- it names a repository of the fleet the token may read, or
- its **service** matches one of **services** or the host of a connected forge.

Everything else is refused and never stored.

- **services**: \`example.com\` covers the host and its subdomains, \`*.example.com\` only subdomains, a name without dots (\`widgets-db\`) exactly that name. Case, scheme, port and path are ignored.
- **channels**: Slack channel ids, e.g. \`C0123ABCD\`; each new report posts kind, variable name, mask, service and repository there, never who sent it. Invite the app first; it needs the \`chat:write\` scope.

Reports fall under the use condition of the Holtkeeper Secret Reports License: nobody may be made to report, and reports are never grounds for sanctions.`,
}
