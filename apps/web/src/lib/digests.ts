import type {
  Digest,
  DigestInput,
  DigestPreset,
  DigestSection,
  DigestTarget,
  Weekday,
} from '@holtkeeper/api'

/** Days of the week, Monday first, with short labels. */
export const weekdayOptions: readonly { id: Weekday; label: string }[] = [
  { id: 'mon', label: 'Mon' },
  { id: 'tue', label: 'Tue' },
  { id: 'wed', label: 'Wed' },
  { id: 'thu', label: 'Thu' },
  { id: 'fri', label: 'Fri' },
  { id: 'sat', label: 'Sat' },
  { id: 'sun', label: 'Sun' },
]

/** What a digest section of each analysis kind brings, for the section picker. */
const sourceDescriptions: Record<string, string> = {
  licenses: 'Licenses your policy forbids or flags',
  audit: 'Vulnerable dependencies and their fixes',
  assets: 'Images to optimize and asset budgets exceeded',
  bundle: 'Bundles that grew past their limits',
  quality: 'Lint, duplication, dead code and secrets',
  delivery: 'Stale merge requests and DORA bands',
  'ci-jobs': 'Slow, flaky and failing CI jobs',
  branches: 'Stale and merged branches',
  'release-risk': 'Risky changes waiting for release',
  coverage: 'Coverage drops',
  fleet: 'Libraries drifting across repositories',
  renovate: 'Dependency update merge requests that need help',
  testids: 'Test ids missing or duplicated',
  warmup: 'Build warm-up problems',
}

/** One line on what a section of `kind` reports. */
export const sourceDescription = (kind: string) =>
  sourceDescriptions[kind] ?? 'Issues of the latest reports'

/** A digest being edited; every field present so controls stay controlled. */
export interface DigestDraft {
  name: string
  enabled: boolean
  all: boolean
  groups: string[]
  every: 'day' | 'week' | 'month'
  days: Weekday[]
  dayOfMonth: number
  time: string
  timezone: string
  sections: DigestSection[]
  onlyNew: boolean
  skipEmpty: boolean
  slackChannels: string[]
  panel: boolean
}

/** The browser's time zone, for new digests. */
const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Time zones offered: the given ones first, then a few common ones. */
export function timezoneOptions(...first: string[]): string[] {
  return [
    ...new Set([
      ...first,
      'UTC',
      'Europe/London',
      'Europe/Berlin',
      'Europe/Moscow',
      'America/New_York',
      'America/Los_Angeles',
      'Asia/Tokyo',
    ]),
  ]
}

/** A new, empty digest: weekly on Monday morning, to the creator's panel chat. */
export const newDraft = (timezone = browserTimezone()): DigestDraft => ({
  name: '',
  enabled: true,
  all: true,
  groups: [],
  every: 'week',
  days: ['mon'],
  dayOfMonth: 1,
  time: '10:00',
  timezone,
  sections: [],
  onlyNew: false,
  skipEmpty: true,
  slackChannels: [],
  panel: true,
})

const section = (input: {
  source: string
  minTone?: DigestSection['minTone']
  limit?: number
}) => ({
  source: input.source,
  minTone: input.minTone ?? 'warning',
  limit: input.limit ?? 8,
})

/** A draft from a preset, keeping only sections whose analysis the server knows. */
export function presetDraft(
  preset: DigestPreset,
  known: ReadonlySet<string>,
  timezone = browserTimezone(),
): DigestDraft {
  const { input } = preset
  return {
    ...newDraft(timezone),
    name: input.name,
    every: input.schedule.every,
    days: input.schedule.days ?? ['mon'],
    dayOfMonth: input.schedule.dayOfMonth ?? 1,
    time: input.schedule.time ?? '10:00',
    sections: input.sections.filter((entry) => known.has(entry.source)).map(section),
    onlyNew: input.onlyNew ?? false,
    skipEmpty: input.skipEmpty ?? true,
  }
}

/** A saved digest as a draft; `userId` decides whether the panel switch is on. */
export function digestDraft(digest: Digest, userId: string): DigestDraft {
  return {
    name: digest.name,
    enabled: digest.enabled,
    all: digest.scope.all === true,
    groups: (digest.scope.groups ?? []).filter((group) => typeof group === 'string'),
    every: digest.schedule.every,
    days: digest.schedule.days,
    dayOfMonth: digest.schedule.dayOfMonth,
    time: digest.schedule.time,
    timezone: digest.schedule.timezone,
    sections: digest.sections,
    onlyNew: digest.onlyNew,
    skipEmpty: digest.skipEmpty,
    slackChannels: digest.targets.flatMap((target) =>
      target.kind === 'slack' ? [target.channel] : [],
    ),
    panel: digest.targets.some((target) => target.kind === 'panel' && target.userId === userId),
  }
}

/**
 * The request body for a draft. Panel targets of other people stay as they were; the caller's own
 * follows the switch. Slack channels lose a leading `#` and blanks.
 */
export function draftInput(draft: DigestDraft, userId: string, existing?: Digest): DigestInput {
  const others: DigestTarget[] = (existing?.targets ?? []).filter(
    (target) => target.kind === 'panel' && target.userId !== userId,
  )
  const channels = [
    ...new Set(
      draft.slackChannels.map((channel) => channel.trim().replace(/^#/, '')).filter(Boolean),
    ),
  ]
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    scope: draft.all ? { all: true } : { groups: draft.groups },
    schedule: {
      every: draft.every,
      days: draft.days,
      dayOfMonth: draft.dayOfMonth,
      time: draft.time,
      timezone: draft.timezone,
    },
    sections: draft.sections,
    onlyNew: draft.onlyNew,
    skipEmpty: draft.skipEmpty,
    targets: [
      ...channels.map((channel) => ({ kind: 'slack' as const, channel })),
      ...(draft.panel ? [{ kind: 'panel' as const, userId }] : []),
      ...others,
    ],
  }
}

/** What keeps a draft from being saved, in words; empty when it can be saved. */
export function draftProblems(draft: DigestDraft): string[] {
  return [
    ...(draft.name.trim() ? [] : ['Give it a name']),
    ...(draft.sections.length ? [] : ['Pick at least one section']),
    ...(draft.all || draft.groups.length ? [] : ['Pick the groups it covers']),
    ...(draft.every === 'month' || draft.days.length ? [] : ['Pick at least one day']),
    ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) ? [] : ['Use a time like 09:30']),
  ]
}

/** Adds or removes the section of an analysis kind. */
export const toggleSection = (draft: DigestDraft, kind: string): DigestDraft => ({
  ...draft,
  sections: draft.sections.some((entry) => entry.source === kind)
    ? draft.sections.filter((entry) => entry.source !== kind)
    : [...draft.sections, section({ source: kind })],
})

/** Changes one section. */
export const editSection = (
  draft: DigestDraft,
  kind: string,
  change: Partial<Pick<DigestSection, 'minTone' | 'limit'>>,
): DigestDraft => ({
  ...draft,
  sections: draft.sections.map((entry) =>
    entry.source === kind ? { ...entry, ...change } : entry,
  ),
})

/** Where a digest goes, in words: `#releases, your chat`. */
export function targetsText(targets: readonly DigestTarget[], userId: string): string {
  const parts = targets.map((target) =>
    target.kind === 'slack'
      ? `#${target.channel}`
      : target.userId === userId
        ? 'your chat'
        : 'a panel chat',
  )
  return parts.length ? parts.join(', ') : 'nowhere yet'
}
