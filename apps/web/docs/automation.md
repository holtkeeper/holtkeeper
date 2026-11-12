# Automation

Part of the web app's [Ops](README.md#automation) docs.

## Automation

**Automation** (`/ops/automation`, `features/automation`, Ops workspace, shown with `settings:read`; editing with `settings:write`, **Run now** with `analyses:run`) is what runs when: event triggers, schedules, merge request policies and freshness. Nothing here is stored as a page model: the rules are projected from the stored trigger and schedule documents (`/api/config/triggers`, `/api/config/schedules`) and the `mergeRequests.policies` and `freshness` settings, and every form saves back to them.

The search params are parsed by `parseAutomationSearch` in `lib/automation.ts`:

| Param      | Meaning                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `view`     | `map`; the list is the default and is left out                                                 |
| `tab`      | the list's rule kind: `triggers`, `policies` or `freshness`; schedules are the default         |
| `lane`     | the map's team (a group id); every repository when absent                                      |
| `schedule` | the schedule whose sheet is open in the list                                                   |
| `rule`     | the rule node id (`rule:trigger:push`, `rule:policy:<setting>:<policy>`, …) whose form is open |
| `job`      | a job whose path the map highlights (Runs' **Show on Automation**); implies the map            |

`automationView` picks the view: `view`, else the map when `job` is set, else the list.

### Header

Crumbs Ops › Automation (› Map), a List | Map switch, a ghost **Configure** that opens Settings › Analyzers, a ⋯ menu with **Copy link**, and **New rule** (`settings:write`), a sheet with Event trigger, Schedule and Merge request policy tabs. On the map a new policy is scoped to the shown team.

### List

The toolbar has the scope switch (_My teams_ keeps rules that cover every repository or sit in a home group, `inMyTeams`), a text filter (name, id, analyzer), the rule kind segments with counts (Triggers, Schedules, MR policies, Freshness with its stale count) and filter pills: Team, and on Schedules also Status and **Problems only**.

- **Schedules**: a `Strip` (schedules, enabled and paused, the next run, scheduled jobs this budget week from `GET /api/jobs/count?trigger=schedule` narrowed to the scope, automatic AI spent this week and its forecast from `GET /api/ai/overview?period=week` (the same numbers as AI spend) with a link to AI spend for `ai:read` or `ai:admin`, then failing, blocked, partly failed and healthy counts), the run legend and a table worst first (`filterSchedules`): name and id, cron or interval with its words (`describeCadence`) and time zone, teams, analyzers with an AI tag, the last 14 runs as ticks, health, last run with its job counts, next run, an on/off switch (`settings:write`, saves the whole schedule with `enabled` flipped) and **Run now**. Other teams' schedules fold into one row. Below it, **Freshness** per team.
- **Triggers** and **MR policies**: one row per rule with what fires it (`describeTrigger`) or its conditions and status, its teams and actions. A row opens the rule's form in a sheet with Rule and Activity tabs.
- **Freshness**: tiles (stale, waiting, fresh, next sweep), then per team the override (On, Slower with a 2–10× factor, Off; saved as the team's own `freshness` entry, **Use the every-repository setting** removes it) with where it comes from and the last sweep's counts (`GET /api/automation/freshness`), then the analyzers that refresh for a picked team with their refresh policy (`describeRefresh`).

The footer names the sweeper's night window and hourly caps (`sweepLimits`) and links to Settings › System to change them.

### Schedule health

`lib/automation.ts` reads runs from `GET /api/schedules/runs?limit=30` (`useScheduleRuns(30)`; `next` holds the next five run times):

- `runOutcome`: running while a job waits or runs; failed when jobs failed and none succeeded; partly failed; blocked by budget; skipped when nothing was queued or everything was canceled; else succeeded. `runTicks` and `runCounts` draw and count them.
- `scheduleHealth(runs, enabled)`: paused when disabled, no runs yet without a finished run, else from the newest finished, not skipped run: failing, partly failed, blocked by budget or healthy, with how many runs in a row failed outright and a rank for worst-first sorting.
- `describeCron` turns common cron shapes into words (`Every day at 02:00`, `Weekdays at 01:30`, `Tue and Thu at 10:00`, `Every 6 hours`, `Every hour at :15`, `Every 15 minutes`; nicknames such as `@daily`) and falls back to `Cron <expression>`; `cronFields` gives the labelled fields; `describeEvery` reads intervals (`Every 2 days`).

### Schedule sheet

A schedule row opens a sheet (J/K step through the shown rows) with the last run as its progress bar, **Run now** and **Pause**/**Resume**, and **Show runs** and **Show on map** in the ⋯ menu. Tabs:

1. **Overview**: a failure callout when the newest run failed or partly failed (the first error, failed repositories, how many runs in a row, **View log** and all jobs of the schedule), the last 30 runs as ticks with their counts, the cron breakdown, the next five runs and the rule (cadence, jitter, groups, repositories, windows, analyzers, spread).
2. **Edit rule**: the schedule form.
3. **Activity**: audit events with the schedule as target (`GET /api/history?targetType=schedule&targetId=`); triggers use `trigger`, policies the `setting` entry.

### Map

One canvas (`FlowCanvas` with zoom controls and a legend) of `mergedLane(lanes, lane)` in `lib/automation-flow.ts`: the every-repository lane merged with the picked team's lane (`automationLanes`, one per config group), so a team sees its own rules and those covering every repository; nodes both share appear once with the team's version, so its freshness override shows. The team segments count each lane's rules (`laneRuleCounts`). `filterLane` narrows it by rule kind (Triggers, Schedules, Policies, Built in; `ruleKind`), **Calls AI only** and a text that matches titles, chips and linked events or actions.

Rule nodes show an AI tag, then Off, a status badge (a failing, partly failed or budget-blocked schedule, stale freshness) or their kind. Clicking one opens its form in the canvas drawer, whose footer (Remove, unsaved changes, Discard, Save rule) stays pinned at the bottom; a schedule also has Health (the overview above) and Activity tabs, and **Open in the schedules list**. With `?job=` a floating notice explains why the job ran (`GET /api/jobs/:id/why`) and the path that could have queued it (`whyPath`) is highlighted; without a `lane` the map opens on the job's team.
