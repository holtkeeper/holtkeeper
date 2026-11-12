import { useNavigate, useSearch } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'

import {
  useConfigEntries,
  useFreshnessOverview,
  useGroups,
  useGroupTitles,
  useJobAnalyzers,
  useScheduleRuns,
  useSettings,
} from '../../api/queries.ts'
import {
  ALL_LANE,
  POLICIES_KEY,
  automationLanes,
  automationRules,
} from '../../lib/automation-flow.ts'
import {
  type AutomationSearch,
  automationView,
  parseAutomationSearch,
} from '../../lib/automation.ts'
import { normalizePolicies, policiesEntryFor } from '../../lib/policies.ts'
import { ErrorState, Page, Placeholder, SegmentedTabs, SideSheet } from '../../ui/index.ts'
import { copyLinkItem } from '../shell/copy-link.ts'
import { useSession } from '../shell/session.ts'
import { AutomationList } from './AutomationList.tsx'
import { AutomationMap } from './AutomationMap.tsx'
import { type AutomationModel, HISTORY_RUNS, type PageHeader } from './model.ts'
import { PolicyForm } from './PolicyForm.tsx'
import { ScheduleForm } from './ScheduleForm.tsx'
import { TriggerForm } from './TriggerForm.tsx'

type Creating = { kind: 'trigger' | 'schedule' } | { kind: 'policy'; group?: string }

const newRuleTabs = [
  { id: 'trigger', label: 'Event trigger' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'policy', label: 'Merge request policy' },
] as const

const views = [
  { id: 'list', label: 'List' },
  { id: 'map', label: 'Map' },
] as const

/**
 * Ops › Automation: what runs when. The list (default) shows triggers, schedules with their
 * health, merge request policies and freshness per team; the map draws one team's events, rules
 * and actions on one canvas. Both edit the same stored documents; "Configure" leads to
 * Settings › Analyzers.
 */
export function AutomationPage() {
  const titleOf = useGroupTitles()
  const { canGlobal } = useSession()
  const writable = canGlobal('settings:write')
  const search = useSearch({ from: '/app/ops/automation' })
  const navigate = useNavigate()
  const setSearch = (patch: Partial<AutomationSearch>) =>
    void navigate({
      to: '/ops/automation',
      search: (previous) => parseAutomationSearch({ ...previous, ...patch }),
      replace: true,
    })
  const triggers = useConfigEntries('triggers')
  const schedules = useConfigEntries('schedules')
  const groups = useGroups()
  const settings = useSettings()
  const analyzers = useJobAnalyzers()
  const freshness = useFreshnessOverview()
  const history = useScheduleRuns(HISTORY_RUNS)
  const [creating, setCreating] = useState<Creating>()
  const view = automationView(search)

  const header: PageHeader = {
    crumbs:
      view === 'map'
        ? [{ label: 'Automation', link: { to: '/ops/automation' } }, { label: 'Map' }]
        : [{ label: 'Automation' }],
    actions: (
      <SegmentedTabs
        aria-label="View"
        items={views}
        selected={view}
        onSelect={(next) =>
          setSearch(
            next === 'map'
              ? { view: 'map', schedule: undefined, rule: undefined }
              : { view: undefined, job: undefined, lane: undefined, rule: undefined },
          )
        }
      />
    ),
    ...(canGlobal('settings:read') && {
      configure: { link: { to: '/settings/$section', params: { section: 'analyzers' } } },
    }),
    more: [copyLinkItem],
    ...(writable
      ? {
          primary: {
            label: 'New rule',
            icon: Plus,
            onPress: () => setCreating({ kind: 'trigger' }),
          },
        }
      : {}),
  }

  if (!triggers.data || !schedules.data || !settings.data || !analyzers.data) {
    const error = triggers.error ?? schedules.error ?? settings.error ?? analyzers.error
    return (
      <Page {...header}>
        {error ? <ErrorState error={error} /> : <Placeholder className="h-96" />}
      </Page>
    )
  }

  const entries = settings.data.settings
  const policySchema = settings.data.definitions.find((d) => d.key === POLICIES_KEY)?.schema
  const input = {
    groups: (groups.data?.entries ?? []).map((group) => group.id),
    triggers: triggers.data.entries,
    schedules: schedules.data.entries,
    settings: entries,
    analyzers: analyzers.data.analyzers,
    titleOf,
  }
  const model: AutomationModel = {
    triggers: input.triggers,
    schedules: input.schedules,
    settings: entries,
    policySchema,
    analyzers: input.analyzers,
    groups: input.groups,
    rules: automationRules(input),
    lanes: automationLanes(input),
    history: new Map(
      (history.data?.schedules ?? []).map((item) => [
        item.id,
        { runs: item.runs, next: item.next },
      ]),
    ),
    freshness: freshness.data,
    writable,
    canRun: canGlobal('analyses:run'),
  }
  const policyIds = entries
    .filter((entry) => entry.key === POLICIES_KEY)
    .flatMap((entry) => normalizePolicies(entry.value).map((policy) => policy.id))
  const newPolicyEntry =
    creating?.kind === 'policy'
      ? policiesEntryFor(entries, POLICIES_KEY, creating.group)
      : undefined
  const done = () => setCreating(undefined)

  return (
    <>
      {view === 'map' ? (
        <AutomationMap model={model} header={header} search={search} setSearch={setSearch} />
      ) : (
        <AutomationList model={model} header={header} search={search} setSearch={setSearch} />
      )}
      <SideSheet
        open={creating !== undefined}
        onClose={done}
        title={
          creating?.kind === 'policy' && creating.group
            ? `New rule for ${titleOf(creating.group)}`
            : 'New rule'
        }
        tabs={{
          items: newRuleTabs.filter((tab) => tab.id !== 'policy' || policySchema !== undefined),
          selected: creating?.kind ?? 'trigger',
          onSelect: (id) =>
            setCreating(
              id === 'trigger' || id === 'schedule'
                ? { kind: id }
                : {
                    kind: 'policy',
                    ...(view === 'map' && search.lane !== undefined && { group: search.lane }),
                  },
            ),
          'aria-label': 'Kind of rule',
        }}
      >
        {creating?.kind === 'trigger' ? (
          <TriggerForm taken={model.triggers.map((t) => t.id)} writable={writable} onDone={done} />
        ) : creating?.kind === 'schedule' ? (
          <ScheduleForm
            taken={model.schedules.map((s) => s.id)}
            writable={writable}
            onDone={done}
          />
        ) : creating?.kind === 'policy' ? (
          <PolicyForm
            key={creating.group ?? ALL_LANE}
            {...(creating.group !== undefined && { group: creating.group })}
            {...(newPolicyEntry && { entry: newPolicyEntry })}
            taken={policyIds}
            schema={policySchema}
            writable={writable}
            onDone={done}
          />
        ) : null}
      </SideSheet>
    </>
  )
}
