import type {
  ConfigEntryView,
  FreshnessOverview,
  JobAnalyzerView,
  ScheduleRun,
  SettingView,
} from '@holtkeeper/api'
import type { ComponentProps } from 'react'

import type { AutomationLane, AutomationRule } from '../../lib/automation-flow.ts'
import { type ScheduleHealth, scheduleHealth } from '../../lib/automation.ts'
import type { Page } from '../../ui/index.ts'

/** Runs the schedule sheet draws as ticks; the list draws the newest 14 of them. */
export const HISTORY_RUNS = 30

/** The header both views give `Page`: crumbs, the view switch, Configure and New rule. */
export type PageHeader = Pick<
  ComponentProps<typeof Page>,
  'crumbs' | 'actions' | 'configure' | 'primary' | 'more'
>

/** Everything both views of Automation read, loaded once by the page. */
export interface AutomationModel {
  triggers: readonly ConfigEntryView<'trigger'>[]
  schedules: readonly ConfigEntryView<'schedule'>[]
  settings: readonly SettingView[]
  /** Form schema of merge request policies; absent when the setting is unknown. */
  policySchema: unknown
  analyzers: readonly JobAnalyzerView[]
  groups: readonly string[]
  rules: readonly AutomationRule[]
  lanes: readonly AutomationLane[]
  history: ReadonlyMap<string, { runs: ScheduleRun[]; next: string[] }>
  freshness: FreshnessOverview | undefined
  writable: boolean
  canRun: boolean
}

/** A schedule as the list and its sheet show it. */
export interface ScheduleRow {
  id: string
  name: string
  entry: ConfigEntryView<'schedule'>
  lanes: readonly string[]
  analyzers: readonly string[]
  ai: boolean
  health: ScheduleHealth
  runs: readonly ScheduleRun[]
  next: readonly string[]
}

/** Every schedule with its lanes, runs and health. */
export function scheduleRows(model: AutomationModel): ScheduleRow[] {
  return model.schedules.map((entry) => {
    const rule = model.rules.find((r) => r.ref.type === 'schedule' && r.ref.id === entry.id)
    const history = model.history.get(entry.id)
    const runs = history?.runs ?? []
    return {
      id: entry.id,
      name: entry.data.name || entry.id,
      entry,
      lanes: rule?.lanes ?? ['all'],
      analyzers: entry.data.analyzers,
      ai: rule?.ai ?? false,
      health: scheduleHealth(runs, entry.data.enabled),
      runs,
      next: history?.next ?? [],
    }
  })
}
