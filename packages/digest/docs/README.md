# @holtkeeper/digest

Scheduled summaries of what analyses found: license problems every Monday, images to optimize on Wednesdays, stale merge requests before the weekend. A digest reads the latest analysis records of its repositories, keeps the issues that matter, and becomes a chat card (`@holtkeeper/chat`), so it renders in Slack, the panel and anywhere else cards go. This package is pure: storing, scheduling and delivering are the server's.

## Model

```ts
interface Digest {
  id: string
  name: string
  enabled: boolean
  scope: Scope // which repositories, as in @holtkeeper/access
  schedule: {
    every: 'day' | 'week' | 'month'
    days: Weekday[] // 'mon' … 'sun', for day and week; default ['mon']
    dayOfMonth: number // 1–28, for month; default 1
    time: string // 'HH:MM', default '10:00'
    timezone: string // IANA, default 'UTC'
  }
  sections: { source: string; minTone: 'info' | 'warning' | 'bad'; limit: number }[] // 1–20
  onlyNew: boolean // only issues the previous digest did not list
  skipEmpty: boolean // send nothing when no section has items (default true)
  targets: ({ kind: 'slack'; channel: string } | { kind: 'panel'; userId: string })[]
  createdBy: string
  createdAt: string
  updatedAt: string
}
```

`digestInputSchema` validates what people edit (everything but `id` and the bookkeeping fields, with defaults); `digestSchema` a stored digest. A section's `source` is an analysis kind (`licenses`, `audit`, `assets`, `bundle`, `quality`, `delivery`, `ci-jobs`, …); `minTone: 'info'` lists everything, `warning` warnings and problems, `bad` problems only; `limit` (1–50, default 8) caps the items shown.

## Schedule

- `scheduleCron(schedule)` — the cron expression: `M H * * <days>` for days and weeks (`*` when every day is listed), `M H <dayOfMonth> * *` for months.
- `nextDigestRun(schedule, after)` — the first run strictly after `after`, in the schedule's time zone (croner).
- `digestDue(schedule, lastRun, now)` — whether a run came due since `lastRun`. Missed slots collapse into one run.
- `describeSchedule(schedule)` — `Every Monday at 10:00`, `Weekdays at 09:30`, `Every Tue, Thu at 10:00`, `Every day at 08:00`, `Monthly on the 2nd at 10:00`.

## Building

`buildDigest({ digest, records, kinds, covers, previousKeys?, resolveUrl?, now })` → `DigestResult`:

- `records` are the latest analysis records (one per repository and kind); those of a section's kind whose repository `covers` accepts are turned into reports with `kinds.get(kind).toReport(record)`.
- Every `issues` block of the report, also nested ones (`reportIssues`), gives items with tone `info`, `warning` or `bad` at the section's `minTone` or above; `good` and `neutral` never count. Item keys are `<kind>:<forge>:<path>:<issue id>`, stable across runs.
- Items are sorted most serious first, then by repository and title, and cut to `limit`; `total` counts them all and `repos` the repositories with a report of the kind.
- With `onlyNew`, items whose key is in `previousKeys` are left out. `keys` lists every qualifying key either way, so an issue that stays is reported once and comes back only after it disappeared.
- `resolveUrl` turns report links (often relative to the panel) into absolute ones; a link it cannot resolve is dropped.
- Unknown kinds and reports that fail to build give empty sections. `empty` is true when no section has items.

`digestCard(digest, result, { url?, subtitle? })` renders it: the digest's name with the most serious tone (`good` when nothing was found), the subtitle as small print, per section with items a line `**Label** · N items in M repositories` (`N new items` with `onlyNew`), the items as `` `path` · title — detail `` with their tone and link, `and K more` when cut, then `All clear: …` for the sections without items. A digest with nothing says `Nothing needs attention.` (or `Nothing new …`).

## Presets

`digestPresets` (each `{ id, label, description, input }`, `input` without scope and targets): `weekly-compliance` (licenses, audit; Mondays), `frontend-hygiene` (assets from `info`, bundle, quality; Wednesdays, only new), `delivery-health` (delivery, ci-jobs, branches; Fridays), `release-watch` (release risk; weekday mornings, only new).
