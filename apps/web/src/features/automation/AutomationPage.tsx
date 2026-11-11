import type { SettingView } from '@holtkeeper/api'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'

import {
  useConfigEntries,
  useFreshnessOverview,
  useGroups,
  useJob,
  useJobAnalyzers,
  useJobTargets,
  useJobWhy,
  useSettings,
} from '../../api/queries.ts'
import {
  ALL_LANE,
  type AutomationLane,
  type AutomationNode,
  POLICIES_KEY,
  type RuleRef,
  automationLanes,
  jobLanes,
  whyPath,
} from '../../lib/automation-flow.ts'
import { normalizePolicies, policiesEntryFor } from '../../lib/policies.ts'
import { repoKey } from '../../lib/repo.ts'
import {
  Button,
  ErrorState,
  FlowCanvas,
  type FlowDrawer,
  Notice,
  Page,
  Placeholder,
  Select,
  SideSheet,
} from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ForecastCard } from './ForecastCard.tsx'
import { FreshnessCard } from './FreshnessCard.tsx'
import { renderAutomationNode } from './nodes.tsx'
import { PolicyForm } from './PolicyForm.tsx'
import { ScheduleForm } from './ScheduleForm.tsx'
import { TriggerForm } from './TriggerForm.tsx'

type Creating = { kind: 'trigger' | 'schedule' } | { kind: 'policy'; group?: string }

const newRuleOptions = [
  { id: 'trigger', label: 'Event trigger' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'policy', label: 'Merge request policy' },
] as const

/**
 * What runs when, per team: one canvas lane per config group (and one for every repository) with
 * events, the rules they start and the actions those take, projected from the stored triggers,
 * schedules, merge request policies and freshness. Clicking a rule opens its form; `?job=<id>`
 * highlights the path that queued that job.
 */
export function AutomationPage() {
  const { can } = useSession()
  const writable = can('settings:write')
  const search = useSearch({ from: '/app/automation' })
  const navigate = useNavigate({ from: '/automation' })
  const triggers = useConfigEntries('triggers')
  const schedules = useConfigEntries('schedules')
  const groups = useGroups()
  const settings = useSettings()
  const analyzers = useJobAnalyzers()
  const overview = useFreshnessOverview()
  const job = useJob(search.job)
  const targets = useJobTargets()
  const [open, setOpen] = useState<{ lane: string; node: string }>()
  const [creating, setCreatingState] = useState<Creating>()
  const setCreating = (next: Creating | undefined) => {
    setOpen(undefined)
    setCreatingState(next)
  }

  if (!triggers.data || !schedules.data || !settings.data || !analyzers.data) {
    const error = triggers.error ?? schedules.error ?? settings.error ?? analyzers.error
    return (
      <Page title="Automation" icon="automation">
        {error ? <ErrorState error={error} /> : <Placeholder className="h-96" />}
      </Page>
    )
  }
  const triggerList = triggers.data.entries
  const scheduleList = schedules.data.entries

  const entries = settings.data.settings
  const policySchema = settings.data.definitions.find((d) => d.key === POLICIES_KEY)?.schema
  const policyIds = entries
    .filter((entry) => entry.key === POLICIES_KEY)
    .flatMap((entry) => normalizePolicies(entry.value).map((policy) => policy.id))
  const newPolicyEntry =
    creating?.kind === 'policy'
      ? policiesEntryFor(entries, POLICIES_KEY, creating.group)
      : undefined
  const known = analyzers.data.analyzers
  const lanes = automationLanes({
    groups: (groups.data?.entries ?? []).map((group) => group.id),
    triggers: triggerList,
    schedules: scheduleList,
    settings: entries,
    analyzers: known,
  })
  const jobGroups = job.data
    ? job.data.group !== undefined
      ? [job.data.group]
      : (targets.data?.targets.find((t) => t.repo === repoKey(job.data.repo))?.groups ?? [])
    : []
  const paths = new Map(
    job.data
      ? lanes
          .filter((lane) => jobLanes(jobGroups).includes(lane.id))
          .flatMap((lane) => {
            const path = whyPath(lane, job.data)
            return path ? [[lane.id, path] as const] : []
          })
      : [],
  )
  const close = () => setOpen(undefined)
  const triggerIds = triggerList.map((entry) => entry.id)
  const scheduleIds = scheduleList.map((entry) => entry.id)

  const ruleContent = (lane: AutomationLane, ref: RuleRef): ReactNode => {
    switch (ref.type) {
      case 'trigger': {
        const entry = triggerList.find((candidate) => candidate.id === ref.id)
        return entry ? (
          <TriggerForm entry={entry} taken={triggerIds} writable={writable} onDone={close} />
        ) : null
      }
      case 'schedule': {
        const entry = scheduleList.find((candidate) => candidate.id === ref.id)
        return entry ? (
          <ScheduleForm
            entry={entry}
            taken={scheduleIds}
            writable={writable}
            runnable={can('analyses:run')}
            onDone={close}
          />
        ) : null
      }
      case 'policy': {
        const entry = entries.find((candidate: SettingView) => candidate.id === ref.settingId)
        return entry ? (
          <PolicyForm
            entry={entry}
            policyId={ref.policyId}
            schema={policySchema}
            writable={writable}
            onDone={close}
          />
        ) : null
      }
      case 'freshness':
        return (
          <FreshnessCard
            {...(lane.group !== undefined && { group: lane.group })}
            analyzers={known}
            overview={overview.data}
            settings={entries}
            writable={writable}
          />
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

  const drawer =
    (lane: AutomationLane) =>
    (node: AutomationNode): FlowDrawer | undefined => {
      if (node.kind !== 'rule') return undefined
      const ref = node.data.ref
      return {
        title: node.data.title,
        ...(ref.type === 'trigger' || ref.type === 'schedule'
          ? { id: ref.id }
          : ref.type === 'policy'
            ? { id: ref.policyId }
            : {}),
        content: ruleContent(lane, ref),
      }
    }

  return (
    <Page
      title="Automation"
      icon="automation"
      description="What runs when, per team. Click a rule to change it."
      actions={
        writable ? (
          <Select
            aria-label="New rule"
            placeholder="New rule…"
            options={newRuleOptions}
            value={undefined}
            onChange={(kind) =>
              setCreating(kind === 'trigger' || kind === 'schedule' ? { kind } : { kind: 'policy' })
            }
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {can('ai:read') ? <ForecastCard /> : null}
        {search.job ? (
          <WhyNotice
            jobId={search.job}
            status={job.data?.status}
            found={paths.size > 0}
            onClear={() => void navigate({ search: {}, replace: true })}
          />
        ) : null}
        {lanes.map((lane) => {
          const path = paths.get(lane.id)
          const edges = path
            ? lane.edges.map((edge) =>
                path.edges.includes(`${edge.from}->${edge.to}`)
                  ? { ...edge, tone: 'accent' as const }
                  : edge,
              )
            : lane.edges
          return (
            <section key={lane.id} className="flex flex-col gap-2" aria-label={lane.label}>
              <header className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold">{lane.label}</h2>
                <span className="text-xs text-muted">
                  {lane.id === ALL_LANE ? 'rules without a team' : 'team'}
                </span>
                {writable && policySchema !== undefined ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onPress={() =>
                      setCreating({
                        kind: 'policy',
                        ...(lane.group !== undefined && { group: lane.group }),
                      })
                    }
                  >
                    New policy
                  </Button>
                ) : null}
              </header>
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
                <FlowCanvas
                  aria-label={`Automation of ${lane.label}`}
                  nodes={lane.nodes}
                  edges={edges}
                  render={renderAutomationNode}
                  drawer={drawer(lane)}
                  openId={open?.lane === lane.id ? open.node : undefined}
                  onOpenChange={(node) => {
                    setCreatingState(undefined)
                    setOpen(node ? { lane: lane.id, node } : undefined)
                  }}
                  {...(path ? { highlight: new Set(path.nodes) } : {})}
                />
                <FreshnessCard
                  {...(lane.group !== undefined && { group: lane.group })}
                  analyzers={known}
                  overview={overview.data}
                  settings={entries}
                  writable={writable}
                />
              </div>
            </section>
          )
        })}
      </div>
      <SideSheet
        open={creating !== undefined}
        onClose={() => setCreating(undefined)}
        title={
          creating?.kind === 'policy'
            ? `New merge request policy${creating.group ? ` for ${creating.group}` : ''}`
            : creating?.kind === 'schedule'
              ? 'New schedule'
              : 'New event trigger'
        }
      >
        {creating?.kind === 'trigger' ? (
          <TriggerForm
            taken={triggerIds}
            writable={writable}
            onDone={() => setCreating(undefined)}
          />
        ) : creating?.kind === 'schedule' ? (
          <ScheduleForm
            taken={scheduleIds}
            writable={writable}
            runnable={false}
            onDone={() => setCreating(undefined)}
          />
        ) : creating?.kind === 'policy' ? (
          <PolicyForm
            key={creating.group ?? ALL_LANE}
            {...(creating.group !== undefined && { group: creating.group })}
            {...(newPolicyEntry && { entry: newPolicyEntry })}
            taken={policyIds}
            schema={policySchema}
            writable={writable}
            onDone={() => setCreating(undefined)}
          />
        ) : null}
      </SideSheet>
    </Page>
  )
}

function WhyNotice({
  jobId,
  status,
  found,
  onClear,
}: {
  jobId: string
  status: string | undefined
  found: boolean
  onClear: () => void
}) {
  const why = useJobWhy(jobId, status ?? 'succeeded')
  return (
    <Notice tone={found ? 'accent' : 'default'} title={`Why job ${jobId.slice(0, 8)} ran`}>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {why.data?.origin ?? 'Loading…'}
          {why.data && !found ? '. No rule on this page queued it.' : why.data ? '.' : ''}
        </span>
        <Link
          to="/jobs/$jobId"
          params={{ jobId }}
          className="text-xs text-muted hover:text-accent hover:underline"
        >
          Open job
        </Link>
        <Button variant="ghost" size="sm" onPress={onClear}>
          Clear
        </Button>
      </span>
    </Notice>
  )
}
