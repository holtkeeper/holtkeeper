import { environmentSummaries } from './deploy.ts'
import { releaseStage } from './facts.ts'
import { planRelease } from './plan.ts'
import type { ReleaseSettings } from './settings.ts'
import type { DeployState, ReleaseBoardRow, ReleaseEdits, ReleaseFacts } from './types.ts'

/**
 * The step whose plan the board shows: `version` while the target branch has unreleased changes,
 * `propose` while only the source branch is ahead (merge request flow), else none.
 */
export function pendingStep(
  settings: ReleaseSettings,
  facts: ReleaseFacts,
): 'propose' | 'version' | undefined {
  if (settings.flow.mode === 'external') return undefined
  if (facts.unreleased.length > 0) return 'version'
  if (settings.flow.mode === 'merge-request' && facts.source && facts.ahead.length > 0)
    return 'propose'
  return undefined
}

export interface BoardRowOptions {
  /** Deploy state of the latest version. */
  deploy?: DeployState
  /** A person's edits of the pending step's plan (`pendingStep`). */
  edits?: ReleaseEdits
}

/**
 * The board row of a repository: its stage, the plan of the pending step (next version, why,
 * tasks, changes left out, failing gates), counts, the open candidate, acceptance, pipelines and,
 * when given, the deploy state of the latest version with what runs on each environment.
 */
export function boardRow(
  settings: ReleaseSettings,
  facts: ReleaseFacts,
  now: Date,
  { deploy, edits }: BoardRowOptions = {},
): ReleaseBoardRow {
  const stage = releaseStage(settings, facts)
  const step = pendingStep(settings, facts)
  const plan = step
    ? planRelease({ step, facts, settings, ...(edits ? { edits } : {}), now })
    : undefined
  const included = plan?.entries.filter((entry) => entry.included) ?? []
  const tickets = [...new Set(included.flatMap((entry) => entry.tickets))]
  const next = plan?.version
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
    ...(plan && next ? { next, bump: plan.suggested.bump } : {}),
    ahead: facts.ahead.length,
    aheadCapped: facts.aheadCapped,
    unreleased: facts.unreleased.length,
    unreleasedCapped: facts.unreleasedCapped,
    tickets,
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
    blockers: (plan?.gates ?? [])
      .filter((gate) => !gate.ok && gate.severity === 'block' && gate.id !== 'acceptance')
      .map((gate) => gate.message),
    acceptanceRequired: settings.flow.mode !== 'external' && settings.acceptance !== 'none',
    reasons: plan?.suggested.reasons.map((reason) => reason.because) ?? [],
    leftOut: plan ? plan.entries.length - included.length : 0,
    tasks: tickets.length,
    environments: environmentSummaries(settings, deploy),
    ...(deploy ? { deploy } : {}),
  }
}
