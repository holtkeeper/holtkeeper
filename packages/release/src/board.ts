import { releaseStage } from './facts.ts'
import { buildEntries, suggestBump } from './notes.ts'
import type { ReleaseSettings } from './settings.ts'
import type { DeployState, ReleaseBoardRow, ReleaseFacts } from './types.ts'
import { nextVersion } from './version.ts'

/**
 * The board row of a repository: its stage, the next version suggested for whatever waits (the
 * target's unreleased changes first, else the source's), counts, the open candidate, acceptance,
 * pipelines and the deploy state of the latest version when given.
 */
export function boardRow(
  settings: ReleaseSettings,
  facts: ReleaseFacts,
  now: Date,
  deploy?: DeployState,
): ReleaseBoardRow {
  const stage = releaseStage(settings, facts)
  const pending = facts.unreleased.length > 0 ? facts.unreleased : facts.ahead
  const labels = (facts.unreleased.length > 0 ? facts.merged?.labels : facts.request?.labels) ?? []
  const entries = buildEntries(pending, settings.changelog)
  const { bump } = suggestBump(entries, settings.version.bump, {
    ...(facts.latest ? { current: facts.latest.version } : {}),
    labels,
  })
  const next =
    stage === 'external'
      ? undefined
      : nextVersion(settings, facts.latest?.version, bump, facts.versions, now)
  const oldest = facts.unreleased.at(-1)?.date
  const waitingSince = facts.merged?.mergedAt ?? oldest
  return {
    repo: facts.repo,
    stage,
    mode: settings.flow.mode,
    webUrl: facts.webUrl,
    ...(facts.source ? { source: facts.source.name } : {}),
    target: facts.target.name,
    ...(facts.latest ? { latest: facts.latest } : {}),
    ...(next ? { next, bump } : {}),
    ahead: facts.ahead.length,
    aheadCapped: facts.aheadCapped,
    unreleased: facts.unreleased.length,
    unreleasedCapped: facts.unreleasedCapped,
    tickets: [
      ...new Set(entries.filter((entry) => entry.included).flatMap((entry) => entry.tickets)),
    ],
    ...(facts.request
      ? {
          request: {
            id: facts.request.id,
            title: facts.request.title,
            webUrl: facts.request.webUrl,
            draft: facts.request.draft,
          },
        }
      : {}),
    pipelines: facts.pipelines,
    ...(facts.acceptance?.sha === facts.target.sha ? { acceptance: facts.acceptance } : {}),
    ...(stage === 'awaiting-version' && waitingSince ? { waitingSince } : {}),
    ...(deploy ? { deploy } : {}),
  }
}
