import { escapeMrkdwn, fit, mrkdwnLink, slackLimits } from '@holtkeeper/notify'
import type { Severity } from '@holtkeeper/vuln'
import type { TriageCategory } from '@holtkeeper/vuln-triage'

import { fitSection } from './announcement.ts'
import type { SlackMessageBody } from './client.ts'

/** One repository an urgent advisory affects, as the alert lists it. */
export interface AlertRepository {
  /** `group/project` path. */
  label: string
  url?: string
  /** Affected versions it is on. */
  versions: string[]
  /** An agent task upgrading the package there is approved or running. */
  fixing?: boolean
}

/** Everything one urgent vulnerability alert shows. */
export interface SecurityAlertContent {
  advisory: { id: string; url?: string; aliases: string[]; summary?: string }
  package: string
  ecosystem: string
  severity: Severity
  fixedIn: string[]
  category: TriageCategory
  /** Why it is urgent: the AI's reason, or the rule that matched. */
  reason: string
  repos: AlertRepository[]
  /** Set once no repository has the advisory any more. */
  resolvedAt?: string
  /** Holtkeeper's security page, where long lists continue. */
  moreUrl?: string
}

const categoryLabels: Readonly<Record<TriageCategory, string>> = {
  malware: 'Malicious package',
  'code-execution': 'Code execution',
  'code-or-secret-theft': 'Code or secret theft',
  'auth-bypass': 'Authentication bypass',
  'data-exposure': 'Data exposure',
  other: 'Other',
}

const code = (text: string) => `\`${text.replaceAll('`', "'")}\``

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })

const repoLine = (repo: AlertRepository) =>
  [
    `• ${repo.url ? mrkdwnLink(repo.url, repo.label) : escapeMrkdwn(repo.label)}`,
    repo.versions.length ? ` — ${repo.versions.map(code).join(', ')}` : '',
    repo.fixing ? ' _(upgrade in progress)_' : '',
  ].join('')

/**
 * The Slack message of an urgent vulnerability: the package and advisory, why it is urgent, and
 * every affected repository with its versions. A resolved alert keeps its content under a
 * "Resolved" header. Text is escaped, so advisory text cannot mention people; sections stay under
 * Slack's limits, long repository lists end with "…and N more".
 */
export function securityAlertMessage(content: SecurityAlertContent): SlackMessageBody {
  const resolved = content.resolvedAt !== undefined
  const title = `${resolved ? '✅ Resolved' : '🚨 Urgent vulnerability'}: ${content.package}`
  const advisory = content.advisory.url
    ? mrkdwnLink(content.advisory.url, content.advisory.id)
    : escapeMrkdwn(content.advisory.id)
  const aliases = content.advisory.aliases.filter((alias) => alias !== content.advisory.id)
  const lead = [
    `*${advisory}*${aliases.length ? ` · ${escapeMrkdwn(aliases.slice(0, 5).join(', '))}` : ''}`,
    ...(content.advisory.summary ? [escapeMrkdwn(content.advisory.summary)] : []),
  ].join('\n')
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: fit(title, slackLimits.header) } },
    section(fit(lead, slackLimits.section)),
    {
      type: 'section',
      fields: [
        `*Package*\n${code(content.package)} (${escapeMrkdwn(content.ecosystem)})`,
        `*Severity*\n${content.severity}`,
        `*Kind*\n${categoryLabels[content.category]}`,
        `*Fixed in*\n${content.fixedIn.length ? content.fixedIn.slice(0, 5).map(code).join(', ') : 'no fix yet'}`,
      ].map((text) => ({ type: 'mrkdwn', text })),
    },
    section(fit(`*Why it is urgent*\n${escapeMrkdwn(content.reason)}`, slackLimits.section)),
    section(
      fitSection(
        resolved
          ? `Was in ${content.repos.length} ${content.repos.length === 1 ? 'repository' : 'repositories'}`
          : `Affected repositories (${content.repos.length})`,
        content.repos.map(repoLine),
        content.moreUrl,
      ),
    ),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [
            resolved
              ? `No repository has it since ${content.resolvedAt?.slice(0, 10)}`
              : 'Holtkeeper urgent vulnerability alert',
            ...(content.moreUrl ? [mrkdwnLink(content.moreUrl, 'All findings')] : []),
          ].join(' · '),
        },
      ],
    },
  ]
  const count = content.repos.length
  const text = resolved
    ? `Resolved: ${content.advisory.id} in ${content.package}`
    : `Urgent vulnerability ${content.advisory.id} in ${content.package}: ${count} ${count === 1 ? 'repository' : 'repositories'}`
  return { text: fit(text, slackLimits.section), blocks }
}

/**
 * The thread reply when an alert's repositories change after posting: repositories that got the
 * advisory (`added`), or the advisory coming back after it was resolved (`reopened`).
 */
export function securityAlertReply(
  kind: 'added' | 'reopened',
  repos: readonly AlertRepository[],
  moreUrl?: string,
): SlackMessageBody {
  const title = kind === 'added' ? 'Also found in' : 'Found again in'
  const text = fitSection(title, repos.map(repoLine), moreUrl)
  return { text, blocks: [section(text)] }
}
