import type { ReleaseSettings } from './settings.ts'
import { dateParts } from './template.ts'
import type { GateResult, PipelineState, ReleaseFacts } from './types.ts'

const minutes = (clock: string) => {
  const [hours = 0, mins = 0] = clock.split(':').map(Number)
  return hours * 60 + mins
}

/** The freeze window `now` falls into, if any; windows with `from > to` span midnight. */
export function activeFreeze(
  settings: ReleaseSettings,
  now: Date,
): ReleaseSettings['gates']['freeze'][number] | undefined {
  const parts = dateParts(now, settings.timezone)
  const current = Number(parts.hour) * 60 + Number(parts.minute)
  return settings.gates.freeze.find((window) => {
    if (window.days?.length && !window.days.some((day) => day === parts.weekday)) return false
    const from = window.from ? minutes(window.from) : 0
    const to = window.to ? minutes(window.to) : 24 * 60
    return from <= to ? current >= from && current < to : current >= from || current < to
  })
}

function pipelineGate(
  settings: ReleaseSettings,
  pipeline: PipelineState | undefined,
  branch: string,
): GateResult | undefined {
  const rule = settings.gates.pipeline
  if (rule === 'off') return undefined
  if (!pipeline)
    return rule === 'success'
      ? { id: 'pipeline', ok: false, message: `${branch} has no pipeline yet` }
      : { id: 'pipeline', ok: true, message: `${branch} has no pipeline` }
  const ok =
    rule === 'success'
      ? pipeline.status === 'success'
      : pipeline.status !== 'failed' && pipeline.status !== 'canceled'
  return {
    id: 'pipeline',
    ok,
    message: ok
      ? `${branch} pipeline ${pipeline.status}`
      : `${branch} pipeline is ${pipeline.status}${rule === 'success' ? ', it must succeed' : ''}`,
  }
}

/**
 * Checks before a step: the pipeline of the branch it works on, freeze windows, blocking merge
 * requests, and for `version` the acceptance when the settings require it. Each result says
 * why; callers refuse failing ones unless a person overrides them.
 */
export function checkGates(
  step: 'propose' | 'version',
  settings: ReleaseSettings,
  facts: ReleaseFacts,
  now: Date,
): GateResult[] {
  const results: GateResult[] = []
  const pipeline =
    step === 'propose'
      ? pipelineGate(settings, facts.pipelines.source, facts.source?.name ?? settings.flow.source)
      : pipelineGate(settings, facts.pipelines.target, facts.target.name)
  if (pipeline) results.push(pipeline)

  const freeze = activeFreeze(settings, now)
  if (settings.gates.freeze.length)
    results.push(
      freeze
        ? {
            id: 'freeze',
            ok: false,
            message: `release freeze${freeze.reason ? `: ${freeze.reason}` : ''}`,
          }
        : { id: 'freeze', ok: true, message: 'outside freeze windows' },
    )

  if (settings.gates.blockingLabels.length)
    results.push(
      facts.blockers.length
        ? {
            id: 'blockers',
            ok: false,
            message: `blocked by ${facts.blockers.map((mr) => `!${mr.id}`).join(', ')}`,
          }
        : { id: 'blockers', ok: true, message: 'no blocking merge requests' },
    )

  if (step === 'version' && settings.acceptance.required) {
    const accepted = facts.acceptance?.sha === facts.target.sha
    results.push(
      accepted
        ? {
            id: 'acceptance',
            ok: true,
            message: `accepted by ${facts.acceptance?.by} (${facts.acceptance?.via})`,
          }
        : {
            id: 'acceptance',
            ok: false,
            message: facts.acceptance
              ? 'new changes reached the target branch after the acceptance'
              : 'the changes are not accepted yet',
          },
    )
  }
  return results
}

/** Whether every gate passed. */
export const gatesPass = (gates: readonly GateResult[]) => gates.every((gate) => gate.ok)
