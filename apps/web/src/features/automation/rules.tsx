import { Link } from '@tanstack/react-router'

import type { RuleRef } from '../../lib/automation-flow.ts'
import { normalizePolicies } from '../../lib/policies.ts'
import { FreshnessAnalyzers, FreshnessTeams, SweepLimitsNote } from './freshness.tsx'
import type { AutomationModel } from './model.ts'
import { PolicyForm } from './PolicyForm.tsx'
import { ScheduleForm } from './ScheduleForm.tsx'
import { TriggerForm } from './TriggerForm.tsx'

/** The audit target of a stored rule, for its Activity; built-in rules have none. */
export function ruleTarget(ref: RuleRef): { type: string; id: string } | undefined {
  switch (ref.type) {
    case 'trigger':
    case 'schedule':
      return { type: ref.type, id: ref.id }
    case 'policy':
      return { type: 'setting', id: ref.settingId }
  }
  return undefined
}

/** The monospace id a rule's sheet shows. */
export function ruleId(ref: RuleRef): string | undefined {
  switch (ref.type) {
    case 'trigger':
    case 'schedule':
      return ref.id
    case 'policy':
      return ref.policyId
  }
  return undefined
}

/**
 * The form of one rule: a trigger, schedule or policy form, the freshness override of `group`
 * (every repository when absent), or a note on the release assistant.
 */
export function RuleEditor({
  rule,
  model,
  group,
  onDone,
}: {
  rule: RuleRef
  model: AutomationModel
  group?: string | undefined
  onDone: () => void
}) {
  const { writable } = model
  switch (rule.type) {
    case 'trigger': {
      const entry = model.triggers.find((candidate) => candidate.id === rule.id)
      return entry ? (
        <TriggerForm
          entry={entry}
          taken={model.triggers.map((t) => t.id)}
          writable={writable}
          onDone={onDone}
        />
      ) : null
    }
    case 'schedule': {
      const entry = model.schedules.find((candidate) => candidate.id === rule.id)
      return entry ? (
        <ScheduleForm
          entry={entry}
          taken={model.schedules.map((s) => s.id)}
          writable={writable}
          onDone={onDone}
        />
      ) : null
    }
    case 'policy': {
      const entry = model.settings.find((candidate) => candidate.id === rule.settingId)
      return entry && normalizePolicies(entry.value).some((p) => p.id === rule.policyId) ? (
        <PolicyForm
          entry={entry}
          policyId={rule.policyId}
          schema={model.policySchema}
          writable={writable}
          onDone={onDone}
        />
      ) : null
    }
    case 'freshness':
      return (
        <div className="flex flex-col gap-4">
          <FreshnessTeams
            lanes={[{ id: group ?? 'all', label: group ?? 'All repositories' }]}
            settings={model.settings}
            overview={model.freshness}
            writable={writable}
          />
          <FreshnessAnalyzers
            group={group}
            analyzers={model.analyzers}
            overview={model.freshness}
          />
          <SweepLimitsNote settings={model.settings} />
        </div>
      )
  }
  return (
    <p className="text-[13px]">
      Tags, pushes and merge requests of repositories with releases on move their release along:
      release merge requests, tags and deploys. Its steps are set per repository on{' '}
      <Link to="/releases" className="text-accent hover:underline">
        Releases
      </Link>
      .
    </p>
  )
}
