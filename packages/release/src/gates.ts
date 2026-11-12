import type { ReleaseSettings } from './settings.ts'
import type { GateResult, PipelineState, ReleaseFacts } from './types.ts'

function pipelineGate(
  settings: ReleaseSettings,
  pipeline: PipelineState | undefined,
  branch: string,
): GateResult | undefined {
  if (!settings.gates.pipeline) return undefined
  if (!pipeline)
    return { id: 'pipeline', ok: true, severity: 'info', message: `${branch} has no pipeline` }
  const ok = pipeline.status !== 'failed' && pipeline.status !== 'canceled'
  return {
    id: 'pipeline',
    ok,
    severity: 'block',
    message: ok
      ? `${branch} pipeline ${pipeline.status}`
      : `${branch} pipeline is ${pipeline.status}`,
  }
}

/**
 * Checks before a step: the pipeline of the branch it works on (failed or canceled blocks, a
 * missing one is `info`), blocking merge requests, and for `version` the acceptance unless
 * `acceptance` is `none`. Each result says why and how much it matters; callers refuse failing
 * `block` ones unless a person overrides them.
 */
export function checkGates(
  step: 'propose' | 'version',
  settings: ReleaseSettings,
  facts: ReleaseFacts,
): GateResult[] {
  const results: GateResult[] = []
  const pipeline =
    step === 'propose'
      ? pipelineGate(settings, facts.pipelines.source, facts.source?.name ?? settings.flow.source)
      : pipelineGate(settings, facts.pipelines.target, facts.target.name)
  if (pipeline) results.push(pipeline)

  if (settings.gates.blockingLabels.length)
    results.push(
      facts.blockers.length
        ? {
            id: 'blockers',
            ok: false,
            severity: 'block',
            message: `blocked by ${facts.blockers.map((mr) => `!${mr.id}`).join(', ')}`,
          }
        : { id: 'blockers', ok: true, severity: 'block', message: 'no blocking merge requests' },
    )

  if (step === 'version' && settings.acceptance !== 'none') {
    const accepted = facts.acceptance?.sha === facts.target.sha
    results.push(
      accepted
        ? {
            id: 'acceptance',
            ok: true,
            severity: 'block',
            message: `accepted by ${facts.acceptance?.by} (${facts.acceptance?.via})`,
          }
        : {
            id: 'acceptance',
            ok: false,
            severity: 'block',
            message: facts.acceptance
              ? 'new changes reached the target branch after the acceptance'
              : 'the changes are not accepted yet',
          },
    )
  }
  return results
}

/** Whether no `block` gate fails; failing `warn` and `info` gates never stop a step. */
export const gatesPass = (gates: readonly GateResult[]) =>
  gates.every((gate) => gate.ok || gate.severity !== 'block')
