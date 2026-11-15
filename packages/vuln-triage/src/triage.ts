import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { Severity } from '@holtkeeper/vuln'
import { z } from 'zod'

import type { AdvisoryDetails } from './osv.ts'

/** Task kind of urgency triage, for model routing and toolsets (it mounts none). */
export const securityTriageTaskKind = 'security-triage'

/** What makes an urgent advisory urgent; `other` for everything else. */
export const triageCategories = [
  'malware',
  'code-execution',
  'code-or-secret-theft',
  'auth-bypass',
  'data-exposure',
  'other',
] as const

export type TriageCategory = (typeof triageCategories)[number]

/** The verdict on one advisory: whether it needs a reaction now, what kind it is and why. */
export interface TriageVerdict {
  urgent: boolean
  category: TriageCategory
  /** One or two sentences for a security engineer, in the requested language. */
  reason: string
}

/** One advisory affecting one package, as the fleet sees it, for `triageAdvisory`. */
export interface TriageInput {
  id: string
  aliases: readonly string[]
  summary?: string
  package: string
  /** OSV ecosystem name: `npm`, `Go`, ... */
  ecosystem: string
  severity: Severity
  /** Affected versions in use across repositories. */
  versions: readonly string[]
  /** Versions that fix it; empty when there is none. */
  fixedIn: readonly string[]
  /** How many repositories have it. */
  repositories: number
  details?: AdvisoryDetails
}

const answerSchema = z.object({
  urgent: z
    .boolean()
    .describe('True only when the advisory needs a reaction today by the rules given'),
  category: z.enum(triageCategories).describe('What the advisory lets an attacker do'),
  reason: z
    .string()
    .describe('One or two sentences: what an attacker gains and under which conditions'),
})

const SYSTEM = [
  'You triage vulnerability advisories of third-party dependencies for a security engineer who must decide what to drop everything for.',
  'Mark an advisory urgent only when, in a typical application using the package, it plausibly leads to serious harm without unusual preconditions:',
  '- the package or a version of it is malicious (install scripts or code that steal or alter data, credentials, source code or the build);',
  '- remote code execution, command injection or unsafe deserialization reachable from untrusted input on a server, CLI or build host;',
  '- reading or changing source code, secrets or credentials;',
  '- authentication or authorization bypass, or arbitrary file read or write, in code that runs on a server.',
  'Do not mark urgent: denial of service, ReDoS, prototype pollution without a known gadget chain, issues only reachable through developer tooling or a build step that processes trusted input, issues that need the attacker to control code, configuration or the machine already, browser-only issues that need unusual user interaction, and theoretical or unconfirmed issues.',
  'When the information is thin, decide from the summary and package role; do not mark urgent from a high score alone.',
  'Base everything on the advisory given; do not invent facts.',
].join('\n')

/**
 * Whether an advisory needs a reaction now, in one call (task kind `security-triage`, tier
 * `main`): the agent reads the advisory, its OSV details, CVSS vectors and CWEs, and answers with
 * a verdict. `reason` is in `language` (English by default); ids and code stay as given. The agent
 * reads nothing else (it runs in an empty temporary directory, with no tools). Rejects when the
 * agent fails, a budget refuses the call or no structured answer comes back.
 */
export async function triageAdvisory(
  agent: Agent,
  input: TriageInput,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<TriageVerdict> {
  const advisory = {
    id: input.id,
    aliases: input.aliases,
    ...(input.summary && { summary: input.summary }),
    package: `${input.package} (${input.ecosystem})`,
    severity: input.severity,
    versionsInUse: input.versions.slice(0, 20),
    fixedIn: input.fixedIn.slice(0, 10),
    repositories: input.repositories,
    ...(input.details?.cvss.length && { cvss: input.details.cvss }),
    ...(input.details?.cwes.length && { cwes: input.details.cwes }),
    ...(input.details?.published && { published: input.details.published }),
    ...(input.details?.details && { details: input.details.details }),
  }
  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-triage-'))
  try {
    const result = await agent.run({
      dir: scratch,
      system: SYSTEM,
      prompt: [
        'Triage this advisory.',
        `Write \`reason\` in ${options.language ?? 'English'}; keep ids, package names and technical terms as they are.`,
        'Advisory as JSON:',
        JSON.stringify(advisory, null, 2),
      ].join('\n\n'),
      capabilities: [],
      output: answerSchema,
      maxTurns: 3,
      taskKind: securityTriageTaskKind,
      tier: 'main',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const answer = result.output
    if (!answer) throw new Error('the agent returned no structured answer')
    return { urgent: answer.urgent, category: answer.category, reason: answer.reason.trim() }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
