import type { Principal } from '@holtkeeper/access'
import { globMatches } from '@holtkeeper/access/paths'
import type { SecretReportingMode } from '@holtkeeper/api'
import { type HoltkeeperConfig, fleetPatterns } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type SecretReport,
  type SecretReportInput,
  type SecretReportStore,
  type SecretReportsAccess,
  type SecretReportsSettings,
  matchesService,
  secretReportStore,
  secretReportsSettingKey,
  secretReportsSettings,
} from '@holtkeeper/secret-reports'
import { webPaths, webUrl } from '@holtkeeper/web-paths'

import { appendAudit } from './audit.ts'
import { type ServerDeps, parseRepo, repoTarget } from './context.ts'
import { slackWebPoster } from './slack/client.ts'
import { slackConnection } from './slack/connection.ts'
import { canSee } from './visibility.ts'

/** Whether `repo` is in the fleet: a configured forge and inside its include and exclude patterns. */
function inFleet(config: HoltkeeperConfig, repo: RepoRef): boolean {
  if (!config.forges[repo.forge]) return false
  const { include, exclude } = fleetPatterns(config, repo.forge)
  return (
    include.some((pattern) => globMatches(pattern, repo.path)) &&
    !exclude.some((pattern) => globMatches(pattern, repo.path))
  )
}

/** Whether this deployment runs secret reports (`server.secretReports`, default on). */
export const secretReportsEnabled = (config: Pick<HoltkeeperConfig, 'server'>) =>
  config.server?.secretReports !== false

/** The `security.secretReports` setting, with defaults. */
async function secretReportsSettingsOf(store: ServerDeps['store']): Promise<SecretReportsSettings> {
  const entry = (await store.settings.list(secretReportsSettingKey)).find(
    (candidate) => candidate.scope.all === true && !candidate.secret,
  )
  return secretReportsSettings(entry?.value)
}

/** Hosts of the connected forges: services that are the organization's without any setting. */
const forgeHosts = (config: HoltkeeperConfig) =>
  Object.values(config.forges).flatMap((forge) => {
    try {
      return [new URL(forge.url).hostname]
    } catch {
      return []
    }
  })

const slackText = (report: SecretReport, url: string | undefined) =>
  [
    `:rotating_light: Exposed secret reported: ${report.kind} \`${report.identifier}\` (${report.masked})`,
    report.service ? `Service: ${report.service}` : undefined,
    report.repo ? `Repository: ${report.repo}` : undefined,
    url ? `Details and status: ${url}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')

/** Secret reports of one server: the store and the MCP access of each caller. */
export interface SecretReports {
  store: SecretReportStore
  /**
   * The `security` toolset access of `principal` reporting as `mode`; `undefined` with `off`.
   * Reports are accepted only about the organization: a fleet repository the principal may read,
   * or a service matching `security.secretReports › services` or a forge host.
   */
  accessFor(principal: Principal, mode: SecretReportingMode): SecretReportsAccess | undefined
}

/**
 * Secret reports over `store.kv`; `undefined` when the feature is off (`server.secretReports:
 * false`) or the store keeps no key-value state. Named reports are audited as
 * `secret_report.create` by their sender; anonymous ones leave no audit event, log line or usage
 * record, only the report itself with its time moved back by up to 10 minutes. Every new report is
 * posted at once to the channels of `security.secretReports`, never naming anyone.
 */
export function secretReportsFor(
  deps: Pick<ServerDeps, 'config' | 'store' | 'vault' | 'now' | 'slackPoster'>,
): SecretReports | undefined {
  const { config, store } = deps
  if (!secretReportsEnabled(config) || !store.kv) return undefined
  const reports = secretReportStore({ kv: store.kv, now: deps.now })
  const pageUrl = (id?: string) => {
    const base = config.server?.publicUrl
    return base ? webUrl(base, webPaths.secretReports(id)) : undefined
  }

  const notify = async (report: SecretReport) => {
    const settings = await secretReportsSettingsOf(store)
    if (!settings.channels.length) return
    const connection = await slackConnection(deps)
    if (!connection) return
    const poster =
      deps.slackPoster?.(connection.botToken) ?? slackWebPoster({ token: connection.botToken })
    const text = slackText(report, pageUrl(report.id))
    await Promise.all(
      settings.channels.map(async (channel) => poster.post({ channel, text }).catch(() => {})),
    )
  }

  const belongs = async (
    principal: Principal,
    input: SecretReportInput,
  ): Promise<string | undefined> => {
    if (input.repo) {
      const repo = parseRepo(input.repo)
      const known =
        repo !== undefined &&
        inFleet(config, repo) &&
        canSee(principal, 'repos:read', repoTarget(config, repo))
      return known
        ? undefined
        : `\`${input.repo}\` is not a repository of the organization you can read; name it as forge:path, or leave repo out and name the service.`
    }
    const settings = await secretReportsSettingsOf(store)
    if (
      input.service &&
      matchesService(input.service, [...settings.services, ...forgeHosts(config)])
    )
      return undefined
    return `\`${input.service ?? ''}\` is not one of the organization's services, so this does not look like the organization's secret. If it is, name the repository it belongs to; administrators can list more services in Settings (security.secretReports).`
  }

  return {
    store: reports,
    accessFor: (principal, mode) => {
      if (mode === 'off') return undefined
      const url = pageUrl()
      return {
        mode,
        ...(url && { pageUrl: url }),
        submit: async (input) => {
          const reason = await belongs(principal, input)
          if (reason) return { status: 'rejected', reason }
          const reporter = mode === 'named' ? { id: principal.id, name: principal.name } : undefined
          const result = await reports.submit(input, reporter)
          if (result.status === 'reported') {
            if (reporter)
              await appendAudit(store, {
                at: deps.now().toISOString(),
                actor: { id: principal.id, name: principal.name, provider: principal.provider },
                via: 'api',
                action: 'secret_report.create',
                target: {
                  type: 'secret_report',
                  id: result.report.id,
                  ...(input.repo && { repo: input.repo }),
                },
                outcome: 'ok',
                details: { kind: input.kind, identifier: input.identifier, through: 'mcp' },
              })
            // The agent's answer must not wait for Slack, and a failed post must not undo the
            // report.
            void notify(result.report).catch(() => {})
          }
          return result
        },
      }
    },
  }
}
