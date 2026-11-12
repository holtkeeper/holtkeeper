import type {
  ConfigEntryView,
  GroupMatch,
  PutConfigInput,
  ScheduleDocumentData,
  ScheduleRun,
  ScheduleWindows,
  TriggerDocumentData,
  Weekday,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { inHomeGroups } from './home-scope.ts'
import { validateGroupId } from './repo.ts'
import { formatGroupMatch, parseGroupMatch } from './scope.ts'

/** Days of the week in the order schedules list them. */
const weekdays: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const dayNames: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

/** `Mon`, `Tue`, … for a weekday. */
const dayLabel = (day: Weekday): string => dayNames[day]

const everyPattern = /^([1-9]\d*)(m|h|d)$/
const hhmmPattern = /^([01]\d|2[0-3]):[0-5]\d$/
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const cronNicknames = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly'])

/** Whether `value` is an interval such as `15m`, `1h` or `1d`. */
export const isEvery = (value: string): boolean => everyPattern.test(value.trim())

/** Whether `value` is a local time `HH:MM`. */
export const isHhmm = (value: string): boolean => hhmmPattern.test(value.trim())

/** Whether `value` is a `YYYY-MM-DD` date. */
export const isIsoDate = (value: string): boolean =>
  isoDatePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

/** Shape check of a cron expression: five or six fields, or a nickname such as `@daily`. */
export function looksLikeCron(expression: string): boolean {
  const trimmed = expression.trim()
  if (cronNicknames.has(trimmed.toLowerCase())) return true
  const fields = trimmed.split(/\s+/)
  return (
    (fields.length === 5 || fields.length === 6) &&
    fields.every((field) => /^[\d*?,/#LW-]+$|^[A-Za-z]{3}([-,][A-Za-z]{3})*$/.test(field))
  )
}

/** Whether the browser knows `zone` as an IANA time zone. */
function isTimeZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== ''
  } catch {
    return false
  }
}

const unitNames: Record<string, string> = { m: 'minute', h: 'hour', d: 'day' }

/** `Every 15 minutes`, `Every hour`, `Every 2 days`; the input itself when it is no interval. */
export function describeEvery(every: string): string {
  const match = everyPattern.exec(every.trim())
  if (!match) return every
  const count = Number(match[1])
  const unit = unitNames[match[2] ?? 'm'] ?? 'minute'
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`
}

/** `Every day`, `Weekdays`, `Weekends` or the listed days, e.g. `Mon, Wed`. */
export function describeDays(days: readonly Weekday[]): string {
  const set = new Set(days)
  const ordered = weekdays.filter((day) => set.has(day))
  if (ordered.length === 7) return 'Every day'
  if (ordered.length === 5 && !set.has('sat') && !set.has('sun')) return 'Weekdays'
  if (ordered.length === 2 && set.has('sat') && set.has('sun')) return 'Weekends'
  return ordered.map(dayLabel).join(', ')
}

/** How often a schedule runs, in words: its interval or its cron expression. */
export function describeCadence(schedule: Pick<ScheduleDocumentData, 'cron' | 'every'>): string {
  if (schedule.every) return describeEvery(schedule.every)
  if (schedule.cron) return describeCron(schedule.cron)
  return 'No cadence'
}

const nicknameCrons: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const cronLabels = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'] as const

/**
 * The fields of a cron expression with their names, for a breakdown: `Minute`, `Hour`, `Day`,
 * `Month`, `Weekday`, with `Second` first for six fields. Nicknames such as `@daily` are expanded;
 * `undefined` when it does not look like cron.
 */
export function cronFields(expression: string): { label: string; value: string }[] | undefined {
  const trimmed = expression.trim()
  if (!looksLikeCron(trimmed)) return undefined
  const fields = (nicknameCrons[trimmed.toLowerCase()] ?? trimmed).split(/\s+/)
  const labels = fields.length === 6 ? ['Second', ...cronLabels] : cronLabels
  return fields.map((value, index) => ({ label: labels[index] ?? '', value }))
}

const cronDays: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}
const plural = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const short = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const isNumber = (field: string) => /^\d+$/.test(field)
const pad = (value: number) => String(value).padStart(2, '0')

const listText = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

const weekday = (token: string) => {
  const value = isNumber(token) ? Number(token) : cronDays[token.toLowerCase()]
  return value === undefined || value > 7 ? undefined : value % 7
}

const stepOf = (field: string) => /^\*\/([1-9]\d*)$/.exec(field)?.[1]

/** Weekday numbers (0 = Sunday) a weekday field names, or `undefined` for anything fancier. */
function weekdaySet(field: string): number[] | undefined {
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const [from, to, ...rest] = part.split('-')
    if (rest.length || from === undefined) return undefined
    const start = weekday(from)
    const end = to === undefined ? start : weekday(to)
    if (start === undefined || end === undefined) return undefined
    for (let value = start; value <= (end < start ? end + 7 : end); value += 1) days.add(value % 7)
  }
  return [...days].toSorted((a, b) => a - b)
}

function dayText(dom: string, month: string, dow: string): string | undefined {
  if (month !== '*') return undefined
  if (dom === '*' || dom === '?') {
    if (dow === '*' || dow === '?') return 'Every day'
    const days = weekdaySet(dow)
    if (!days?.length) return undefined
    if (days.length === 7) return 'Every day'
    if (days.join() === '1,2,3,4,5') return 'Weekdays'
    if (days.join() === '0,6') return 'Weekends'
    if (days.length === 1) return plural[days[0] ?? 0]
    return listText(days.map((day) => short[day] ?? ''))
  }
  if (isNumber(dom) && (dow === '*' || dow === '?')) return `On day ${Number(dom)} of every month`
  return undefined
}

/**
 * A cron expression in words, e.g. `Every day at 02:00`, `Weekdays at 01:30`,
 * `Tue and Thu at 10:00`, `Every 6 hours` or `Every 15 minutes`; `Cron <expression>` when it is
 * beyond these shapes. Times are in the schedule's time zone, which the text leaves out.
 */
export function describeCron(expression: string): string {
  const fallback = `Cron ${expression.trim()}`
  const fields = cronFields(expression)?.map((field) => field.value)
  if (!fields) return fallback
  const [minute = '', hour = '', dom = '', month = '', dow = ''] =
    fields.length === 6 ? fields.slice(1) : fields
  const days = dayText(dom, month, dow)
  if (!days) return fallback
  const everyDay = days === 'Every day'
  if (isNumber(minute) && hour.split(',').every(isNumber)) {
    const times = hour.split(',').map((h) => `${pad(Number(h))}:${pad(Number(minute))}`)
    return `${days} at ${listText(times)}`
  }
  const repeat = (text: string) => (everyDay ? text : `${days}, ${text.toLowerCase()}`)
  if (isNumber(minute) && (hour === '*' || stepOf(hour))) {
    const every = hour === '*' ? 'Every hour' : `Every ${stepOf(hour)} hours`
    return repeat(Number(minute) === 0 ? every : `${every} at :${pad(Number(minute))}`)
  }
  if (hour === '*' && (minute === '*' || stepOf(minute)))
    return repeat(minute === '*' ? 'Every minute' : `Every ${stepOf(minute)} minutes`)
  return fallback
}

/** How one schedule run went, from its job counts. */
export type RunOutcome = 'running' | 'succeeded' | 'partial' | 'failed' | 'blocked' | 'skipped'

/**
 * The outcome of a run: `running` while a job waits or runs, `failed` when jobs failed and none
 * succeeded, `partial` when some failed, `blocked` when the AI budget stopped some, `skipped` when
 * it queued nothing or everything was canceled, else `succeeded`.
 */
export function runOutcome(run: ScheduleRun): RunOutcome {
  if (run.queued + run.running > 0) return 'running'
  if (run.failed > 0) return run.succeeded > 0 ? 'partial' : 'failed'
  if (run.blocked > 0) return 'blocked'
  if (run.jobs === 0 || run.canceled === run.jobs) return 'skipped'
  return 'succeeded'
}

/** Words and tick tone of each run outcome. */
export const runOutcomes: Record<RunOutcome, { label: string; tone: StatusTone | 'skipped' }> = {
  running: { label: 'Running', tone: 'accent' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  partial: { label: 'Partly failed', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked by budget', tone: 'code' },
  skipped: { label: 'Skipped', tone: 'skipped' },
}

const outcomeOrder: readonly RunOutcome[] = [
  'running',
  'succeeded',
  'partial',
  'failed',
  'blocked',
  'skipped',
]

/** Runs as ticks, oldest first, at most `count` of the newest. `runs` are newest first. */
export const runTicks = (
  runs: readonly ScheduleRun[],
  count: number,
): { at: string; outcome: RunOutcome }[] =>
  runs
    .slice(0, count)
    .toReversed()
    .map((run) => ({ at: run.at, outcome: runOutcome(run) }))

/** `28 succeeded · 2 failed`: how many runs had each outcome, in outcome order. */
export function runCounts(runs: readonly ScheduleRun[]): string {
  const counts = new Map<RunOutcome, number>()
  for (const run of runs) counts.set(runOutcome(run), (counts.get(runOutcome(run)) ?? 0) + 1)
  return outcomeOrder
    .filter((outcome) => counts.has(outcome))
    .map((outcome) => `${counts.get(outcome)} ${runOutcomes[outcome].label.toLowerCase()}`)
    .join(' · ')
}

/** Health states of a schedule, worst first. */
export const scheduleStates = [
  'failing',
  'blocked',
  'partial',
  'never',
  'healthy',
  'paused',
] as const

/** Health state of a schedule. */
export type ScheduleState = (typeof scheduleStates)[number]

const stateLabels: Record<ScheduleState, string> = {
  failing: 'Failing',
  blocked: 'Blocked by budget',
  partial: 'Partly failed',
  never: 'No runs yet',
  healthy: 'Healthy',
  paused: 'Paused',
}

const stateTones: Record<ScheduleState, StatusTone> = {
  failing: 'danger',
  blocked: 'code',
  partial: 'warning',
  never: 'default',
  healthy: 'success',
  paused: 'default',
}

/** Label and tag tone of each health state. */
export const scheduleStateLabel = (state: ScheduleState) => stateLabels[state]

/** How a schedule is doing, from its runs. */
export interface ScheduleHealth {
  state: ScheduleState
  label: string
  tone: StatusTone
  /** Position in a worst-first sort. */
  rank: number
  /** Finished runs in a row, newest first, that failed outright. */
  failedInRow: number
  /** The newest finished run that is not skipped; health is read from it. */
  last?: ScheduleRun
}

/**
 * The health of a schedule from its runs (newest first): `paused` when disabled, `never` with no
 * finished run, else read from the newest finished, not skipped run: `failing` when it failed
 * outright, `partial` when some jobs failed, `blocked` when the AI budget stopped some, else
 * `healthy`. Running runs are left out until they finish.
 */
export function scheduleHealth(runs: readonly ScheduleRun[], enabled: boolean): ScheduleHealth {
  const finished = runs.filter((run) => !['running', 'skipped'].includes(runOutcome(run)))
  const last = finished[0]
  const firstOk = finished.findIndex((run) => runOutcome(run) !== 'failed')
  const failedInRow = firstOk < 0 ? finished.length : firstOk
  const outcome = last ? runOutcome(last) : undefined
  const state: ScheduleState = !enabled
    ? 'paused'
    : outcome === undefined
      ? 'never'
      : outcome === 'failed'
        ? 'failing'
        : outcome === 'partial'
          ? 'partial'
          : outcome === 'blocked'
            ? 'blocked'
            : 'healthy'
  return {
    state,
    label: stateLabels[state],
    tone: stateTones[state],
    rank: scheduleStates.indexOf(state),
    failedInRow,
    ...(last && { last }),
  }
}

/** Whether a health state needs someone to look: failing, partly failed or blocked by budget. */
export const isProblem = (state: ScheduleState): boolean =>
  state === 'failing' || state === 'partial' || state === 'blocked'

/** Lane id rules covering every repository use, as `automation-flow` names it. */
const EVERY_REPOSITORY = 'all'

/**
 * Whether a rule belongs to the viewer's teams: it covers every repository, or its groups include
 * one of the home groups. A UI default, not a permission.
 */
export const inMyTeams = (lanes: readonly string[], homeGroups: readonly GroupMatch[]): boolean =>
  lanes.includes(EVERY_REPOSITORY) || inHomeGroups(homeGroups, lanes)

/** What the schedule list filters by. */
export interface ScheduleFilter {
  q?: string
  /** Lane ids, e.g. `all` or a group. */
  teams?: readonly string[]
  states?: readonly ScheduleState[]
  problems?: boolean
}

/** A schedule row as the list filters and sorts it. */
interface ScheduleRowLike {
  id: string
  name: string
  lanes: readonly string[]
  analyzers: readonly string[]
  health: ScheduleHealth
}

/**
 * Rows matching `filter`, worst health first, then by name: the text matches name, id or an
 * analyzer; teams and states keep rows in one of them; `problems` keeps those needing a look.
 */
export function filterSchedules<T extends ScheduleRowLike>(
  rows: readonly T[],
  filter: ScheduleFilter,
): T[] {
  const needle = filter.q?.trim().toLowerCase()
  return rows
    .filter(
      (row) =>
        (!needle ||
          [row.name, row.id, ...row.analyzers].some((text) =>
            text.toLowerCase().includes(needle),
          )) &&
        (!filter.teams?.length || row.lanes.some((lane) => filter.teams?.includes(lane))) &&
        (!filter.states?.length || filter.states.includes(row.health.state)) &&
        (!filter.problems || isProblem(row.health.state)),
    )
    .toSorted((a, b) => a.health.rank - b.health.rank || a.name.localeCompare(b.name))
}

/** Rule kinds the list shows as tabs. */
const automationTabs = ['triggers', 'schedules', 'policies', 'freshness'] as const

/** A tab of the Automation list. */
export type AutomationTab = (typeof automationTabs)[number]

/**
 * Search params of Ops › Automation: `view` (list by default, or map), the list's `tab`
 * (schedules by default), the map's team `lane`, the open `schedule` sheet or `rule` drawer (a
 * rule node id), and `job`, whose path the map highlights.
 */
export interface AutomationSearch {
  view?: 'list' | 'map'
  tab?: Exclude<AutomationTab, 'schedules'>
  lane?: string
  schedule?: string
  rule?: string
  job?: string
}

const listTabs: readonly NonNullable<AutomationSearch['tab']>[] = [
  'triggers',
  'policies',
  'freshness',
]

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** Normalised search params; defaults are left out, unknown values dropped. */
export function parseAutomationSearch(search: Record<string, unknown>): AutomationSearch {
  const view = search.view === 'map' ? 'map' : undefined
  const tab = listTabs.find((id) => id === search.tab)
  const lane = text(search.lane)
  const schedule = text(search.schedule)
  const rule = text(search.rule)
  const job = text(search.job)
  return {
    ...(view && { view }),
    ...(tab && { tab }),
    ...(lane && { lane }),
    ...(schedule && { schedule }),
    ...(rule && { rule }),
    ...(job && { job }),
  }
}

/** The view a search shows: the map when asked for or when it explains a job, else the list. */
export const automationView = (search: AutomationSearch): 'list' | 'map' =>
  search.view ?? (search.job ? 'map' : 'list')

/** Short phrases for a schedule's windows, e.g. `Weekdays 09:00–18:00`, `no weekends`. */
export function describeWindows(windows: ScheduleWindows | undefined): string[] {
  if (!windows) return []
  const parts = [
    ...(windows.allow ?? []).map((w) => `${describeDays(w.days)} ${w.from}–${w.to}`),
    ...(windows.deny ?? []).map((w) => `not ${describeDays(w.days)} ${w.from}–${w.to}`),
  ]
  if (windows.skipWeekends) parts.push('no weekends')
  if (windows.skipNights)
    parts.push(`no nights ${windows.skipNights.from}–${windows.skipNights.to}`)
  if (windows.holidays?.length)
    parts.push(windows.holidays.length === 1 ? '1 holiday' : `${windows.holidays.length} holidays`)
  return parts
}

/** One allow or deny window as the schedule dialog edits it. */
interface WindowDraft {
  days: Weekday[]
  from: string
  to: string
}

/** What the schedule dialog edits. */
export interface ScheduleDraft {
  id: string
  name: string
  enabled: boolean
  cadence: 'every' | 'cron'
  every: string
  cron: string
  timezone: string
  analyzers: string[]
  groups: string[]
  repos: string[]
  allow: WindowDraft[]
  deny: WindowDraft[]
  skipWeekends: boolean
  skipNights: boolean
  nightFrom: string
  nightTo: string
  holidays: string[]
  jitterMinutes: string
  spread: boolean
  /** Options per analyzer kind; only those of picked analyzers are saved. */
  options?: ScheduleDocumentData['options']
}

/** Problems of a schedule draft by field. */
export type ScheduleDraftErrors = Partial<
  Record<
    | 'id'
    | 'every'
    | 'cron'
    | 'timezone'
    | 'analyzers'
    | 'repos'
    | 'allow'
    | 'deny'
    | 'nights'
    | 'holidays'
    | 'jitterMinutes',
    string
  >
>

/** The draft of a schedule entry, or a blank one running every day. */
export function toScheduleDraft(entry?: ConfigEntryView<'schedule'>): ScheduleDraft {
  const data = entry?.data
  const windows = data?.windows
  return {
    id: entry?.id ?? '',
    name: data?.name && data.name !== entry?.id ? data.name : '',
    enabled: data?.enabled ?? true,
    cadence: data?.cron ? 'cron' : 'every',
    every: data?.every ?? (data?.cron ? '' : '1d'),
    cron: data?.cron ?? '',
    timezone: data?.timezone ?? '',
    analyzers: [...(data?.analyzers ?? [])],
    groups: (data?.groups ?? []).map(formatGroupMatch),
    repos: [...(data?.repos ?? [])],
    allow: (windows?.allow ?? []).map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    deny: (windows?.deny ?? []).map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    skipWeekends: windows?.skipWeekends ?? false,
    skipNights: windows?.skipNights !== undefined,
    nightFrom: windows?.skipNights?.from ?? '22:00',
    nightTo: windows?.skipNights?.to ?? '07:00',
    holidays: [...(windows?.holidays ?? [])],
    jitterMinutes: data?.jitterMinutes ? String(data.jitterMinutes) : '',
    spread: data?.spread ?? false,
    ...(data?.options ? { options: data.options } : {}),
  }
}

const windowError = (windows: readonly WindowDraft[]): string | undefined => {
  for (const window of windows) {
    if (window.days.length === 0) return 'Pick at least one day for every window'
    if (!isHhmm(window.from) || !isHhmm(window.to)) return 'Times are HH:MM, e.g. 09:30'
  }
  return undefined
}

/** Problems by field; `taken` are ids a new schedule must not reuse. */
export function validateScheduleDraft(
  draft: ScheduleDraft,
  taken: readonly string[] = [],
): ScheduleDraftErrors {
  const errors: ScheduleDraftErrors = {}
  const id = draft.id.trim()
  const idError = validateGroupId(id)
  if (idError) errors.id = idError
  else if (taken.includes(id)) errors.id = 'A schedule with this id exists'
  if (draft.cadence === 'every' && !isEvery(draft.every))
    errors.every = 'An interval such as 15m, 1h or 1d'
  if (draft.cadence === 'cron' && !looksLikeCron(draft.cron))
    errors.cron = 'A cron expression, e.g. 0 3 * * 1-5'
  if (draft.timezone.trim() && !isTimeZone(draft.timezone.trim()))
    errors.timezone = 'An IANA time zone, e.g. Europe/Berlin'
  if (draft.analyzers.length === 0) errors.analyzers = 'Pick at least one analyzer'
  if (draft.repos.some((repo) => !/^[^:]+:.+$/.test(repo)))
    errors.repos = 'Repositories are forge:path globs'
  const allow = windowError(draft.allow)
  if (allow) errors.allow = allow
  const deny = windowError(draft.deny)
  if (deny) errors.deny = deny
  if (draft.skipNights && (!isHhmm(draft.nightFrom) || !isHhmm(draft.nightTo)))
    errors.nights = 'Times are HH:MM, e.g. 22:00'
  if (draft.holidays.some((day) => !isIsoDate(day))) errors.holidays = 'Dates are YYYY-MM-DD'
  const jitter = draft.jitterMinutes.trim()
  if (jitter && !(/^\d+$/.test(jitter) && Number(jitter) <= 1440))
    errors.jitterMinutes = 'Whole minutes, 0 to 1440'
  return errors
}

const copyWindow = (window: WindowDraft) => ({
  days: weekdays.filter((day) => window.days.includes(day)),
  from: window.from.trim(),
  to: window.to.trim(),
})

/** The `PUT /api/config/schedules/:id` body of a valid draft; empty parts are left out. */
export function toScheduleInput(draft: ScheduleDraft): PutConfigInput['schedule'] {
  const windows: ScheduleWindows = {
    ...(draft.allow.length ? { allow: draft.allow.map(copyWindow) } : {}),
    ...(draft.deny.length ? { deny: draft.deny.map(copyWindow) } : {}),
    ...(draft.skipWeekends ? { skipWeekends: true } : {}),
    ...(draft.skipNights
      ? { skipNights: { from: draft.nightFrom.trim(), to: draft.nightTo.trim() } }
      : {}),
    ...(draft.holidays.length ? { holidays: draft.holidays.toSorted() } : {}),
  }
  const jitter = Number(draft.jitterMinutes.trim() || '0')
  const options = pickedOptions(draft)
  return {
    name: draft.name.trim() || draft.id.trim(),
    enabled: draft.enabled,
    analyzers: [...draft.analyzers],
    ...(draft.cadence === 'every' ? { every: draft.every.trim() } : { cron: draft.cron.trim() }),
    ...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : {}),
    ...(draft.groups.length ? { groups: draft.groups.map(parseGroupMatch) } : {}),
    ...(draft.repos.length ? { repos: [...draft.repos] } : {}),
    ...(Object.keys(windows).length ? { windows } : {}),
    ...(jitter > 0 ? { jitterMinutes: jitter } : {}),
    ...(draft.spread ? { spread: true } : {}),
    ...(options ? { options } : {}),
  }
}

const pickedOptions = (draft: ScheduleDraft): ScheduleDocumentData['options'] => {
  const entries = Object.entries(draft.options ?? {}).filter(
    ([kind, value]) => draft.analyzers.includes(kind) && Object.keys(value).length > 0,
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Kinds of event triggers. */
export type TriggerKind = TriggerDocumentData['on']

/** Kinds of triggers with their labels, in the order the panel lists them. */
export const triggerKinds: readonly { id: TriggerKind; label: string }[] = [
  { id: 'tag', label: 'Tag pushed' },
  { id: 'push', label: 'Branch push' },
  { id: 'mergeRequest', label: 'Merge request' },
  { id: 'newRepo', label: 'New repository' },
  { id: 'label', label: 'Label added' },
  { id: 'command', label: 'Comment command' },
]

/** Merge request events a trigger may react to. */
export const mergeRequestActions = ['open', 'update', 'reopen'] as const

/**
 * The fixed document id of a trigger: `tag`, `push`, `merge-request`, `new-repo`,
 * `label:<label>`, `command:<name>`.
 */
export function triggerId(
  trigger:
    | { on: 'tag' }
    | { on: 'push' }
    | { on: 'mergeRequest' }
    | { on: 'newRepo' }
    | { on: 'label'; label: string }
    | { on: 'command'; command: string },
): string {
  switch (trigger.on) {
    case 'tag':
      return 'tag'
    case 'push':
      return 'push'
    case 'mergeRequest':
      return 'merge-request'
    case 'newRepo':
      return 'new-repo'
    case 'label':
      return `label:${trigger.label.trim()}`
  }
  return `command:${trigger.command.trim()}`
}

/** What the trigger dialog edits; fields of other kinds are ignored. */
export interface TriggerDraft {
  on: TriggerKind
  analyzers: string[]
  /** Analyzers a new repository trigger leaves out. */
  exclude: string[]
  groups: string[]
  /** Branch globs of a push trigger; empty means every branch. */
  branches: string[]
  actions: (typeof mergeRequestActions)[number][]
  draft: boolean
  label: string
  command: string
  analyzer: string
  args: string[]
}

/** Problems of a trigger draft by field. */
export type TriggerDraftErrors = Partial<
  Record<'analyzers' | 'actions' | 'label' | 'command' | 'analyzer' | 'id', string>
>

/** The draft of a trigger, or a blank one of `kind`. */
export function toTriggerDraft(
  data?: TriggerDocumentData,
  kind: TriggerKind = 'mergeRequest',
): TriggerDraft {
  const draft: TriggerDraft = {
    on: data?.on ?? kind,
    analyzers: [],
    exclude: [],
    groups: [],
    branches: [],
    actions: [],
    draft: false,
    label: '',
    command: '',
    analyzer: '',
    args: [],
  }
  if (!data) return draft
  switch (data.on) {
    case 'tag':
      return {
        ...draft,
        analyzers: [...data.analyzers],
        groups: (data.groups ?? []).map(formatGroupMatch),
      }
    case 'push':
      return {
        ...draft,
        analyzers: [...data.analyzers],
        groups: (data.groups ?? []).map(formatGroupMatch),
        branches: [...(data.branches ?? [])],
      }
    case 'mergeRequest':
      return {
        ...draft,
        analyzers: [...data.analyzers],
        groups: (data.groups ?? []).map(formatGroupMatch),
        actions: [...(data.actions ?? [])],
        draft: data.draft ?? false,
      }
    case 'newRepo':
      return {
        ...draft,
        analyzers: [...(data.analyzers ?? [])],
        exclude: [...(data.exclude ?? [])],
        groups: (data.groups ?? []).map(formatGroupMatch),
      }
    case 'label':
      return { ...draft, analyzers: [...data.analyzers], label: data.label }
  }
  return {
    ...draft,
    command: data.command,
    analyzer: data.analyzer,
    args: [...(data.args ?? [])],
  }
}

/** Problems by field; `taken` are trigger ids a new trigger must not reuse. */
export function validateTriggerDraft(
  draft: TriggerDraft,
  taken: readonly string[] = [],
): TriggerDraftErrors {
  const errors: TriggerDraftErrors = {}
  if (draft.on === 'command') {
    if (!/^[a-z][\w-]*$/.test(draft.command.trim()))
      errors.command = 'Lowercase letters, digits, _ and -'
    if (!draft.analyzer) errors.analyzer = 'Pick the analyzer to run'
  } else if (draft.on !== 'newRepo' && draft.analyzers.length === 0)
    errors.analyzers = 'Pick at least one analyzer'
  if (draft.on === 'label' && !draft.label.trim()) errors.label = 'Enter the label'
  if (!errors.command && !errors.label && taken.includes(triggerId(toTriggerInput(draft))))
    errors.id = 'This trigger exists; edit it instead'
  return errors
}

/** The `PUT /api/config/triggers/:id` body of a valid draft. */
export function toTriggerInput(draft: TriggerDraft): TriggerDocumentData {
  switch (draft.on) {
    case 'tag':
      return {
        on: 'tag',
        analyzers: [...draft.analyzers],
        ...(draft.groups.length ? { groups: draft.groups.map(parseGroupMatch) } : {}),
      }
    case 'push':
      return {
        on: 'push',
        analyzers: [...draft.analyzers],
        ...(draft.branches.length ? { branches: [...draft.branches] } : {}),
        ...(draft.groups.length ? { groups: draft.groups.map(parseGroupMatch) } : {}),
      }
    case 'mergeRequest':
      return {
        on: 'mergeRequest',
        analyzers: [...draft.analyzers],
        ...(draft.actions.length && draft.actions.length < mergeRequestActions.length
          ? { actions: mergeRequestActions.filter((a) => draft.actions.includes(a)) }
          : {}),
        ...(draft.draft ? { draft: true } : {}),
        ...(draft.groups.length ? { groups: draft.groups.map(parseGroupMatch) } : {}),
      }
    case 'newRepo':
      return {
        on: 'newRepo',
        ...(draft.analyzers.length ? { analyzers: [...draft.analyzers] } : {}),
        ...(draft.exclude.length ? { exclude: [...draft.exclude] } : {}),
        ...(draft.groups.length ? { groups: draft.groups.map(parseGroupMatch) } : {}),
      }
    case 'label':
      return { on: 'label', label: draft.label.trim(), analyzers: [...draft.analyzers] }
  }
  return {
    on: 'command',
    command: draft.command.trim(),
    analyzer: draft.analyzer,
    ...(draft.args.length ? { args: [...draft.args] } : {}),
  }
}

/** One line on when a trigger fires, e.g. `/holtkeeper port <targets>`. */
export function describeTrigger(trigger: TriggerDocumentData): string {
  switch (trigger.on) {
    case 'tag':
      return 'A tag is pushed'
    case 'push':
      return trigger.branches?.length
        ? `Commits are pushed to ${trigger.branches.join(', ')}`
        : 'Commits are pushed to any branch'
    case 'mergeRequest': {
      const actions = trigger.actions?.length ? trigger.actions : mergeRequestActions
      return `Merge request ${actions.join(', ')}${trigger.draft ? ', drafts included' : ''}`
    }
    case 'newRepo':
      return trigger.exclude?.length
        ? `A repository is found for the first time; skips ${trigger.exclude.join(', ')}`
        : 'A repository is found for the first time'
    case 'label':
      return `Label "${trigger.label}" is added to a merge request`
  }
  return [`/holtkeeper ${trigger.command}`, ...(trigger.args ?? []).map((a) => `<${a}>`)].join(' ')
}

/** Analyzers a trigger queues; empty for a new repository trigger that runs every read-only one. */
export const triggerAnalyzers = (trigger: TriggerDocumentData): string[] =>
  trigger.on === 'command' ? [trigger.analyzer] : (trigger.analyzers ?? [])
