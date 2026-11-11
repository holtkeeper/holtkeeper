import type {
  ConfigEntryView,
  PutConfigInput,
  ScheduleDocumentData,
  ScheduleWindows,
  TriggerDocumentData,
  Weekday,
} from '@holtkeeper/api'

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
function describeEvery(every: string): string {
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
  if (schedule.cron) return `Cron ${schedule.cron}`
  return 'No cadence'
}

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
