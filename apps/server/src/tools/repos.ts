import { type Principal, can } from '@holtkeeper/access'
import { type RegistryTool, defineTool } from '@holtkeeper/agent-tools'
import type { FindingsResponse, LicensePolicySummary, LicensesOverview } from '@holtkeeper/api'
import { z } from 'zod'

import type { RepoFilter } from '../api-surface/catalog.ts'
import { type ServerDeps, groupLabeler, repoTarget } from '../context.ts'
import { type FindingsFilter, readFindings } from '../findings.ts'
import { createFleetCache } from '../fleet-cache.ts'
import { licensesOverview } from '../licenses.ts'
import { canSee } from '../visibility.ts'

/** `repo` when it is a `forge:path` the caller may read, else `undefined`. */
export function readableRepo(canRead: RepoFilter, repo: string | undefined): string | undefined {
  if (!repo) return undefined
  const separator = repo.indexOf(':')
  if (separator < 1) return undefined
  return canRead({ forge: repo.slice(0, separator), path: repo.slice(separator + 1) })
    ? repo
    : undefined
}

/**
 * Supply facts for one asker, answering exactly what `GET /api/audits/findings` and
 * `GET /api/licenses` answer them: findings over the repositories they may read audits of,
 * licenses over the ones they may read analyses of.
 */
export interface SupplyToolsAccess {
  findings(filter?: FindingsFilter): Promise<FindingsResponse>
  licenses(): Promise<LicensesOverview>
  /** How a group key is named in tool output; default the key itself. */
  groupLabel?: (key: string) => string
}

/**
 * A `SupplyToolsAccess` factory per asker. Answers are kept in fleet caches shared by every asker
 * of one factory, keyed like the HTTP endpoints' (the latest records and the asker's visible
 * repositories).
 */
export function supplyToolsAccess(
  deps: Pick<ServerDeps, 'config' | 'analyses' | 'now'> & {
    store: Pick<ServerDeps['store'], 'analyses' | 'tasks' | 'settings'>
  },
): (principal: Principal) => SupplyToolsAccess {
  const { config, store } = deps
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const findingsCache = createFleetCache()
  const licenses = {
    analyses: store.analyses,
    settings: store.settings,
    kinds,
    targetOf: (repo: { forge: string; path: string }) => repoTarget(config, repo),
    cache: createFleetCache(),
  }
  return (principal) => ({
    findings: (filter = {}) =>
      readFindings(
        {
          config,
          store,
          kinds,
          cache: findingsCache,
          today: deps.now().toISOString().slice(0, 10),
        },
        principal,
        filter,
      ),
    licenses: () =>
      licensesOverview(
        licenses,
        (target) => canSee(principal, 'analyses:read', target),
        can(principal, 'settings:read', { kind: 'scope', scope: { all: true } }),
      ),
    groupLabel: groupLabeler(config),
  })
}

const day = (timestamp: string) => timestamp.slice(0, 10)
const list = (values: readonly string[]) => values.join(', ')
const code = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(', ')

const findingStatuses = ['open', 'fixing', 'allowlisted'] as const
const severities = ['critical', 'high', 'medium', 'low', 'unknown'] as const

type GroupLabel = (key: string) => string

function renderFindings(
  response: FindingsResponse,
  options: { severity?: string; status?: string; limit: number },
  label: GroupLabel,
): string {
  const { severities: counts } = response
  const groups = response.groups.filter(
    (group) =>
      (!options.severity || group.severity === options.severity) &&
      (!options.status || group.status === options.status),
  )
  const header = `# ${response.groups.length} finding${response.groups.length === 1 ? '' : 's'}: ${severities.map((severity) => `${counts[severity]} ${severity}`).join(', ')}`
  if (!groups.length) return `${header}\n\nNo finding matches.`
  const shown = groups.slice(0, options.limit)
  return [
    header,
    ...(options.severity || options.status
      ? [`${groups.length} match ${[options.severity, options.status].filter(Boolean).join(', ')}.`]
      : []),
    '',
    ...shown.flatMap((group) => [
      `- **${group.advisory}**${group.aliases.length ? ` (${list(group.aliases)})` : ''} ${group.package} (${group.ecosystem}) — ${group.severity}, ${group.status}${group.taskId ? ` by task ${group.taskId}` : ''}${group.summary ? `: ${group.summary}` : ''}. ${group.fixedIn.length ? `Fixed in ${list(group.fixedIn)}` : 'No fix'}; first seen ${day(group.firstSeenAt)}${group.url ? `; ${group.url}` : ''}`,
      ...group.repos.map(
        (repo) =>
          `  - \`${repo.repo}\`${repo.groups.length ? ` (${list(repo.groups.map(label))})` : ''}: ${list(repo.versions)} in ${code(repo.sources)}, ${repo.status}${repo.taskId ? ` by task ${repo.taskId}` : ''}`,
      ),
    ]),
    ...(groups.length > shown.length
      ? ['', `${groups.length - shown.length} more; narrow with repo, severity or status.`]
      : []),
  ].join('\n')
}

const delta = (name: string, value: { added: number; resolved: number }) =>
  `${name} +${value.added}/-${value.resolved}`

function renderPolicy(policy: LicensePolicySummary): string {
  const exceptions = policy.exceptions
  return `Policy${policy.preset ? ` (${policy.preset})` : ''}: allow ${list(policy.allow) || 'nothing'}; deny ${list(policy.deny) || 'nothing'}${policy.review.length ? `; needs review ${list(policy.review)}` : ''}${policy.ignore.length ? `; ignore ${list(policy.ignore)}` : ''}; unknown licenses ${policy.unknown === 'violation' ? 'are violations' : 'warn'}${policy.devDependencies === 'ignore' ? '; dev-only dependencies are not judged' : ''}${policy.requireProjectLicense ? '; a project license file is required' : ''}${policy.overrides ? `; ${policy.overrides} narrower override${policy.overrides === 1 ? '' : 's'}` : ''}.${exceptions.length ? `\nExceptions: ${exceptions.map((exception) => `${exception.package}${exception.version ? `@${exception.version}` : ''}${exception.license ? ` (${exception.license})` : ''}: ${exception.reason}${exception.expires ? `, until ${exception.expires}` : ''}`).join('; ')}.` : ''}`
}

function renderLicenses(
  overview: LicensesOverview,
  repo: string | undefined,
  label: GroupLabel,
): string {
  const rows = repo ? overview.repos.filter((row) => row.repo === repo) : overview.repos
  const violations = repo
    ? overview.violations.filter((violation) =>
        violation.repos.some((entry) => entry.repo === repo),
      )
    : overview.violations
  if (!rows.length)
    return repo
      ? `No license scan of \`${repo}\` you may read.`
      : 'No license scan of a repository you may read.'
  const { kpi, policy, deltas } = overview
  const header = repo
    ? `# Licenses of \`${repo}\``
    : `# Licenses across ${kpi.repos} repositories: ${kpi.packages} packages, ${kpi.denied} denied, ${kpi.review} need review, ${kpi.unknown} unknown, ${kpi.licenses} licenses (${kpi.allowedLicenses} allowed), ${kpi.internal} internal, ${kpi.missingLicenseFile} missing a license file`
  return [
    header,
    ...(policy ? [renderPolicy(policy)] : []),
    ...(deltas && !repo
      ? [
          `Since ${day(deltas.since)}: ${delta('denied', deltas.denied)}, ${delta('review', deltas.review)}, ${delta('unknown', deltas.unknown)}.`,
        ]
      : []),
    '',
    '## Violations',
    ...(violations.length
      ? violations.map(
          (violation) =>
            `- **${violation.package}** (${violation.ecosystem}) ${violation.verdict}: ${list(violation.licenses) || 'no license'}, versions ${list(violation.versions)}${violation.culprits.length ? `, because of ${list(violation.culprits)}` : ''}${violation.dev ? ', dev only' : ''}; in ${code(violation.repos.map((entry) => entry.repo))}`,
        )
      : ['None.']),
    '',
    '## Repositories',
    ...rows.map(
      (row) =>
        `- \`${row.repo}\`${row.groups.length ? ` (${list(row.groups.map(label))})` : ''}: ${row.packages} packages — ${row.verdicts.denied} denied, ${row.verdicts.unlisted} need review, ${row.verdicts.unknown} unknown, ${row.verdicts.allowed} allowed, ${row.verdicts.ignored} ignored, ${row.verdicts.internal} internal${row.verdicts.excepted ? `, ${row.verdicts.excepted} excepted` : ''}${row.licenseFile === 'missing' ? '; license file missing' : ''}; scanned ${day(row.createdAt)}`,
    ),
    ...(repo
      ? []
      : [
          '',
          '## License mix',
          ...overview.mix.map((entry) => `- ${entry.license}: ${entry.packages}`),
        ]),
  ].join('\n')
}

/**
 * `security_findings` and `license_overview` over `access`: the same groups, rows and narrowing
 * as `GET /api/audits/findings` and `GET /api/licenses`, as text.
 */
export function supplyTools(access: SupplyToolsAccess): RegistryTool[] {
  const label = access.groupLabel ?? ((key: string) => key)
  return [
    defineTool({
      name: 'security_findings',
      description:
        'Vulnerability findings from the newest audit of every repository you may read audits of, one entry per advisory and package with severity, fixed versions, the affected repositories and whether a fix is running or the finding is allowlisted. Narrow with repo, severity or status.',
      input: z.object({
        repo: z.string().optional().describe('Only this repository, as forge:path'),
        severity: z.enum(severities).optional(),
        status: z.enum(findingStatuses).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      }),
      run: async ({ repo, severity, status, limit }) =>
        renderFindings(
          await access.findings(repo ? { repos: [repo] } : {}),
          {
            ...(severity ? { severity } : {}),
            ...(status ? { status } : {}),
            limit: limit ?? 50,
          },
          label,
        ),
      subject: ({ repo }) => repo,
    }),
    defineTool({
      name: 'license_overview',
      description:
        'License compliance from the newest license scan of every repository you may read analyses of: totals, the license policy, packages it denies or wants reviewed, a row per repository and the license mix. Pass repo for one repository.',
      input: z.object({
        repo: z.string().optional().describe('Only this repository, as forge:path'),
      }),
      run: async ({ repo }) => renderLicenses(await access.licenses(), repo, label),
      subject: ({ repo }) => repo,
    }),
  ]
}
