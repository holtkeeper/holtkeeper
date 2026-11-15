import type { FindingUrgency } from '@holtkeeper/api'
import type { KvStore } from '@holtkeeper/store'
import { isMalwareAdvisory, triageCategories } from '@holtkeeper/vuln-triage'
import { z } from 'zod'

/** Where the urgent alerts' state lives in `store.kv`. */
const SECURITY_ALERTS_KEY = 'security:alerts:state'

const repoSchema = z.object({
  label: z.string(),
  url: z.string().optional(),
  versions: z.array(z.string()),
  fixing: z.boolean().optional(),
})

const contentSchema = z.object({
  advisory: z.object({
    id: z.string(),
    url: z.string().optional(),
    aliases: z.array(z.string()),
    summary: z.string().optional(),
  }),
  package: z.string(),
  ecosystem: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']),
  fixedIn: z.array(z.string()),
  category: z.enum(triageCategories),
  reason: z.string(),
  repos: z.array(repoSchema),
  resolvedAt: z.string().optional(),
  moreUrl: z.string().optional(),
})

const alertSchema = z.object({
  advisory: z.string(),
  package: z.string(),
  ecosystem: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  verdict: z
    .object({
      urgent: z.boolean(),
      category: z.enum(triageCategories),
      reason: z.string(),
      by: z.enum(['rule', 'ai']),
      at: z.string(),
    })
    .optional(),
  triageAttempts: z.number().int().default(0),
  triageRetryAt: z.string().optional(),
  /** `waiting`: not posted yet (untriaged or urgent); `quiet`: triaged as not urgent. */
  status: z.enum(['waiting', 'posted', 'quiet']),
  postAttempts: z.number().int().default(0),
  postRetryAt: z.string().optional(),
  /** Posted messages; `url` is the message's permalink once Slack gave one. */
  posts: z
    .array(z.object({ channel: z.string(), ts: z.string(), url: z.string().optional() }))
    .default([]),
  /** Repositories (`forge:path`) the posted message names. */
  repos: z.array(z.string()).default([]),
  /** What the posted message shows, to rewrite it once resolved. */
  shown: contentSchema.optional(),
  resolvedAt: z.string().optional(),
})

const stateSchema = z.object({ alerts: z.record(z.string(), alertSchema) })

/** One advisory and package the alerts follow, and how far reporting it got. */
export type SecurityAlert = z.infer<typeof alertSchema>
/** What the store keeps: every followed advisory and package by `advisory|ecosystem|package`. */
export type SecurityAlertsState = z.infer<typeof stateSchema>

/** The stored alerts' state; empty when none is stored or it does not parse. */
export async function readAlertsState(kv: KvStore | undefined): Promise<SecurityAlertsState> {
  return stateSchema.safeParse(await kv?.get(SECURITY_ALERTS_KEY)).data ?? { alerts: {} }
}

/** Replaces the stored alerts' state. */
export async function saveAlertsState(kv: KvStore | undefined, state: SecurityAlertsState) {
  await kv?.set(SECURITY_ALERTS_KEY, state)
}

/** The key alerts and audit findings share: `advisory|ecosystem|package`. */
export const alertKeyOf = (finding: { advisory: string; ecosystem: string; package: string }) =>
  `${finding.advisory}|${finding.ecosystem}|${finding.package}`

/** The reason of a malware verdict, which is made by rule. */
export const malwareReason = (advisory: string, pkg: string) =>
  `${advisory} reports ${pkg} as a malicious package. Remove it, then rotate the credentials and check the machines that installed it.`

/** What `urgencyOf` needs to know of a finding. */
export interface UrgencyCandidate {
  advisory: string
  aliases: readonly string[]
  summary?: string
  ecosystem: string
  package: string
  /** When the finding was first seen: the time of a malware verdict nothing stored. */
  firstSeenAt: string
}

/**
 * Reads the stored verdicts once and answers the urgency of findings: the stored verdict (with the
 * first Slack permalink of a posted alert), else for malicious packages an urgent verdict by rule,
 * even while alerts are off, else `undefined`.
 */
export async function findingUrgencies(
  kv: KvStore | undefined,
): Promise<(finding: UrgencyCandidate) => FindingUrgency | undefined> {
  const { alerts } = await readAlertsState(kv)
  return (finding) => {
    const alert = alerts[alertKeyOf(finding)]
    if (alert?.verdict) {
      const slackUrl =
        alert.status === 'posted' ? alert.posts.find((post) => post.url)?.url : undefined
      return { ...alert.verdict, ...(slackUrl && { slackUrl }) }
    }
    const malware = isMalwareAdvisory({
      id: finding.advisory,
      aliases: [...finding.aliases],
      ...(finding.summary && { summary: finding.summary }),
    })
    if (!malware) return undefined
    return {
      urgent: true,
      category: 'malware',
      reason: malwareReason(finding.advisory, finding.package),
      by: 'rule',
      at: finding.firstSeenAt,
    }
  }
}
