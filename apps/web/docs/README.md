# @holtkeeper/web

The Holtkeeper admin panel: dashboards, audit reports, background jobs, automation (schedules, triggers, repository traits), credentials, settings, AI usage, storage, caches, users, your own account (passkeys and linked external accounts, at `/account`), the audit log and the activity log. A single-page React app that talks only to the server's JSON API (`/api/*`) and auth endpoints (`/auth/*`). The server serves the built files from `apps/web/dist`.

Stack: React 19, HeroUI 3 (React Aria + Tailwind CSS 4), TanStack Router (code-based routes), TanStack Query, TanStack Table, Motion, Recharts, React Flow (`@xyflow/react`) with dagre layouts, lucide icons, `@simplewebauthn/browser` for passkeys.

## Running

```sh
# API server on :7420 (see apps/server/docs), then in another terminal:
cd apps/web
bun run dev          # Vite dev server, proxies /api and /auth to http://localhost:7420
bun run build        # writes apps/web/dist, which the server picks up
```

Set `HOLTKEEPER_SERVER=http://host:port` to proxy to another server. Session cookies work through the proxy because requests stay same-origin.

Checks: `tsc -p apps/web` (part of `bun run typecheck`), `bun test apps/web`, `bun run lint`.

## Layout

```
index.html            theme bootstrap script (no flash of the wrong theme)
vite.config.ts        react + tailwind plugins, dev proxy, output to dist/
src/
  main.tsx            QueryClient (401 → refetch /api/me), RouterProvider
  router.tsx          route tree; pages are lazy-loaded
  app.css             Tailwind + HeroUI styles, severity and chart color tokens
  api/                the only code that knows URLs
    client.ts         request(): JSON over fetch with the session cookie, ApiError
    endpoints.ts      one typed function per endpoint
    queries.ts        TanStack Query hooks and query keys
  lib/                pure helpers with *.test.ts next to them
    access.ts         can(principal, action), action list, grant summaries
    findings.ts       finding rows, Language → tool → file → package grouping, search
    dashboard.ts      totals, active-findings trend, breakdowns, top packages
    fixes.ts          fix attempts grouped into per-file fixer chains
    units.ts          report values by unit (bytes, %, ms…), signed deltas, delta tone, cell sorting
    tree.ts           treemap sizing (parents sum children), drill-down paths, "Other" folding
    graph.ts          highlighted cycle paths, graph capping, dagre layered and grouped layouts
    markdown.ts       safe markdown subset parser (no raw HTML, http(s)/mailto links only)
    analyses.ts       block type list, analysis pages, trend metrics and their series
    diff.ts           unified and split diff rows with line numbers, hunk headers, stats
    selection.ts      change selection, "select all safe", conflicts per change, MR titles
    format.ts         relative dates, durations, expiry tone
    scope.ts          scope description, normalisation, pattern and group intersection text
    schema.ts         JSON Schema → setting editor kind (x-editor picks a dedicated editor)
    policies.ts       merge request policies: normalising, cleaning, plain-words summary, checks
    trackers.ts       trackers: part variants, roles provided and read (x-role), links, checks
    jobs.ts           job status tones and labels, durations, analyzers per target scope
    automation.ts     schedule, trigger and repository traits forms ↔ panel documents, cadence text
    ai-usage.ts       USD and token formatting, month deltas, daily series, budget tone
    audit-log.ts      audit log filter form → query, outcome tones, change values
    storage.ts        provider ordering and shares, clear results
    caches.ts         egress cache totals, per host sizes, entry filter, hit rate, TTL text
    libraries.ts      library list and docs search queries, version roles, source statuses, plain-text excerpts
    media.ts          image variant form validation, savings tone, snippet labels
    accounts.ts       external account providers, verification labels, link form
    schema-form.ts    JSON Schema → form fields (objects, records, lists, variants, $ref)
    severity.ts, repo.ts, theme.ts
  ui/                 thin wrappers over HeroUI and shared visual pieces
  features/<area>/    one folder per page: shell, auth, dashboard, audits, repos, analyses,
                      reports, credentials, settings, access (Scope/Grants editors), users, account, activity,
                      jobs, automation, ai, audit-log, storage, caches, media, libraries
```

## API client

Pages never call `fetch`. `api/endpoints.ts` maps every endpoint to a typed function using the shared types from `@holtkeeper/api` (types and browser-safe helpers only; no runtime code from other packages). `api/queries.ts` wraps them in hooks; mutations invalidate the affected query keys. Errors arrive as `ApiError` with the HTTP status; a 401 anywhere refetches `/api/me`, which shows the sign-in page.

## Access in the UI

Scope editors (grants, settings, knowledge) and the schedule and trigger dialogs take group intersections as `frontend + storefront`: one tag that means both groups at once (`formatGroupMatch` / `parseGroupMatch` in `lib/scope.ts`).

`lib/access.ts` `can(principal, action)` only asks whether any grant names the action (or `*`). It decides which navigation entries and buttons to show; the server still checks the exact scope on every request, and pages show "No access" on a 403.

## UI wrappers

Everything from `@heroui/react` is imported in `src/ui/` only. Pages use `Button`, `Panel`, `Dialog` (`size="xl"` for wide editors), `Markdown`, `TextField`, `Select`, `Switch`, `Checkbox`, `Segmented`, `MultiToggle`, `Tabs`, `Tooltip`, `SearchInput`, `notify` and friends from `ui/index.ts`, so replacing the component kit means rewriting `src/ui/` and nothing else. Wrappers expose small, explicit props rather than passing HeroUI props through. Tables (`Table`, report tables, heatmaps, diffs, the dependency matrix) cap their height with `tableScrollClass` and scroll inside under a sticky header; paged lists end in `LoadMore`, a show-more button that also presses itself when scrolled into view, placed inside the table's scroll area when there is one.

## Build warm-up

`/warmup` (sidebar Delivery → Build warm-up, `features/warmup/WarmupPage.tsx`) lists runs of the `warmup` analyzer, newest first, from `GET /api/jobs?analyzer=warmup` joined with their records by `analysisId` (`lib/warmup.ts`): the command's outcome (`ok`, `failed`, `timed out` from the record; the job status while it is queued or running, since a failing build still ends the job as succeeded), repository, branch, commit, trigger, start, duration, and links to the job log and to the report with the output tail. Below it are the usual duration trends and repository cards of the analysis kind. The repository picker narrows everything to one repository.

## Proxy secrets

Credentials of kind `egress-secret` ("Proxy secret") hold a secret the egress proxy puts into job requests in place of a placeholder (`EgressSecretFields.tsx`): a generated UUID with copy and regenerate buttons, more hosts, paths, methods and where to replace (headers, URL, body). The URL is where the secret goes, e.g. a Turborepo remote cache. The form keeps them as `options`, see the server docs on egress rules.

## Forges

The Credentials page also lists forges (global `settings:read`). With global `settings:write` you add a GitLab forge (id, URL and a GitLab token credential, `PUT /api/config/forges/:id`), edit or delete panel forges, and issue, rotate or remove a forge's SSH key (`POST`/`DELETE /api/forges/:id/ssh-key`): what it is used for (clone and push, signing, or both), its lifetime and an optional commit identity. Forges from the config file are shown read-only. `forge-form.ts` holds the form's validation.

## Repositories and groups

`/repos` shows headline cards (repositories, audited this week, with critical or high findings, active findings) and a table: the path with its namespace dimmed, forge and groups; active findings with a severity bar and fixed/allowlisted counts; the last audit with a freshness dot (week, month, older, never; `auditFreshness` in `lib/repo.ts`); and, with `analyses:read`, one icon per analysis kind linking to its newest record (dimmed when there is none, metrics in the tooltip). A strip of groups sits above it. **Add repository** (global `settings:write`) adds an exact path to an existing group of the chosen forge or to a new group through `PUT /api/config/groups/:id` (`withRepo` in `lib/repo.ts`); a group from the config file becomes a panel copy that replaces it. `/repos/view?repo=forge:path` and `/repos/groups/:id` show one repository or group with tabs: **Settings** (`ScopedSettings`: entries naming it, and for a repository the effective value and where it comes from; new entries start scoped to it), **Knowledge** (`ScopedKnowledge`), for a repository **Updates** (`RepoUpdates`: polling cadence, last and next poll, a warning when the token's budget slows it down, **Poll now** and the recent polls, scheduled or by hand, with their result; the repository's webhook URL with copy, **Regenerate**, **Turn off**, **Register on GitLab**, the last delivery and setup steps for adding it by hand) and, for a group, its include and exclude patterns, **Listing on the forge** (`GroupListing`: what the patterns resolve to, **List now** and the recent listings with their errors) and known repositories, plus **Fleet** (`analyses:read`, once the group's forge is known): its `fleet` records (`fleetView` in `lib/analyses.ts`, stored under `{ forge, path: <group> }`) with trends of repositories behind a major and drifted config files. **Stack** next to it lists the group's `stack` records (`stackView`, also in `groupAnalysisPages`) with trends of repositories on end-of-life versions and behind a major. `lib/scope.ts` `namesFocus` decides which entries belong to the page: the exact group, or the exact repository path with or without its forge.

## Jobs

`/jobs` lists background analyzer runs (`analyses:read`) with a status filter and optional `?repo=` and `?schedule=` filters (a job's trigger column links its schedule), refreshing every few seconds while some are queued or running. `/jobs/$jobId` shows a job's details, its options, error and a log that follows new lines, **Cancel** for queued and running jobs and **Open result** once it stored an analysis. `RunJobDialog` (`analyses:run`, only when the config has `jobs`) queues an analyzer: the target is fixed by the page (repository, group) or picked, the options form comes from the analyzer's JSON Schema (`GET /api/jobs/analyzers`) with its presets. Repository and group pages, the Audits page (**Run audit**, the `audit` analyzer) and every analysis page (**Run now** with that page's analyzer, also in its empty state) open it. **Analyze past releases** on the Releases page (for the picked repository or all of them) and on repository pages queues changelogs for the newest 10–100 tags without one, optionally with release risk assessments, and opens the Jobs page.

## Automation

`/automation` (`settings:read`, editing with global `settings:write`) edits what the config file's `jobs` and `repos` sections set, as panel documents layered over the file (`/api/config/<collection>`), with a provenance chip per entry and its earlier versions. **Schedules**: interval or cron, time zone, allow and deny windows, weekends, nights, holidays, jitter and spread, analyzers, groups and repositories, the last run (state, a bar of its jobs by status, how long it took, a link to its jobs, failures on hover), the ten runs before it as small bars, the next runs, and **▶** to run it now (`analyses:run`, `POST /api/schedules/:id/run`); switching a file schedule off stores a panel override. **Triggers**: tag, merge request, label and command triggers. **Traits**: repository traits per path pattern with typed values. **Runtime**: the file-only parts (`GET /api/config/runtime`: dry run, job execution, storage, limits, AI providers, plugin uses), read-only, and **Export config** (`GET /api/config/export`). The Credentials page's forges get a webhook block: a panel forge generates or rotates its secret and registers the hook on GitLab (`POST /api/forges/:id/webhook`), the secret shown once.

## Repository config and media

A repository's **Config** tab shows what the config applies to it (`GET /api/repos/explain`, like `holtkeeper explain`): groups, traits, plugins with options, and the schedules and triggers that queue jobs for it. **Optimize image** (`analyses:run`) generates image variants of a file (`POST /api/media/variants`), compares sizes, previews variants, shows markup snippets and puts the chosen files into a merge request or a ZIP (`POST /api/media/apply`).

## AI usage, storage and audit log

`/ai` (`ai:read`): this month against the previous one, budgets with month-end projections, daily cost for 30 days, top repositories, models and task kinds, and every run with links to its job and analysis. `/storage` (`settings:read`): space per storage area with breakdowns and **Clear** where the area allows it (`settings:write`). `/caches` (`settings:read`): the egress proxy's download cache (`GET /api/egress/cache`) — stored size, bytes saved by hits, hit rate and bytes served since the answering replica started, packages and tools with their TTL and largest hosts, every entry with size, hits, last use and expiry (filter by kind and URL), the store and cached URL patterns, a warning that cached copies outlive upstream and access changes, and removing one entry, a kind or everything (`settings:write`). `/audit-log` (global `audit:read`): filters, count, events with expandable request details and changes, hash chain verification and CSV or NDJSON export of the filtered events. `/account` also lists linked external accounts, links new ones and issues verification codes.

## Knowledge

`/knowledge` lists entries by status (proposals first), filters by kind and text, and edits entries in `KnowledgeDialog` (scope, task kinds, topics, packages, evidence, live Markdown preview). Saving a proposal can accept it in the same step; accepting goes through `POST /api/knowledge/:id/accept`, so the entry it supersedes is archived. Form rules live in `lib/knowledge.ts`.

## Settings

`/settings` has one tab per setting section plus **Resolve for repository**; the tab and the chosen repository live in the URL (`?tab=ai&repo=…`). Each setting shows its entries per scope next to its `help`. Adding or editing an entry opens a wide editor: scope and value on the left, the setting's guidance on the right. Settings with `presets` get a **Preset** picker above the value (`PresetPicker`, helpers in `lib/presets.ts`): applying one merges its fields into an object value (replaces other values) and remounts the value editor; the picker shows the preset the value already matches. Values get a form built from their JSON Schema, except `x-editor: merge-request-policies`, which `PolicyEditor` edits as blocks: per policy an **If** block (conditions joined by _and_, with **Any of**, **All of** and **Not** groups) and a **Then** block (actions with their options from the action variants of the schema, _Stop here_, _Skip analyzers_), a one-line summary, and a JSON toggle. `x-editor: trackers` gets `TrackerEditor`: entity and key normalization, a read-only map (`@xyflow/react`) of sources by role → rules that read those roles → outputs, with rules that read a role no source provides and sources no rule reads called out, then Sources, Rules and Outputs blocks whose options come from the kind variants of the schema. Shared rails and remove buttons live in `features/settings/blocks.tsx`.

## Repository avatars

`RepoAvatar` shows `GET /api/repos/avatar` (uploaded, the forge's project or group avatar, or generated initials) in the repositories table, on repository pages and on analysis cards, with initials if the image fails. On a repository page the large avatar uploads a new one on click (`settings:write`, PNG, JPEG, WebP or GIF up to 512 kB) and resets it to the forge or generated one; every image of the repository reloads after a change.

## Analyses and reports

Analyses (`changelog`, `bundle`, `depgraph`, …) all produce the universal `Report` from `@holtkeeper/report`. The sidebar has **Releases**, **Bundles**, **Dependencies**, **Code quality**, **Test coverage**, **Test ids**, **Branches**, **CI jobs**, **Licenses**, **Assets**, **Fleet**, **Tech stack** and **Public API** (shown with `analyses:read`); without a repository each shows one card per repository with its avatar, newest run, headline metrics as tiles with their change since the run before, a sparkline of the page's trend metric and who ran it, sortable by name, recency or that metric; with a repository it lists the runs with their changes and trends of its preferred metrics (gzip/size for bundles, issues/coverage for quality, line coverage/files without tests for coverage, share with a test id/missing for test ids, to clean up/stale for branches, violations/unknown for licenses, potential savings/total size for assets; see `analysisPages` in `lib/analyses.ts`). **Fleet** and **Tech stack** are group analyses (`groupAnalysisPages`): their cards are one per group, the picker lists groups (`?repo=forge:group`) and **Run now** targets the picked group; each group page shows the same records in its **Fleet** and **Stack** tabs. `/analyses/$id` renders the record with `ReportView` and a "compare with" picker that sets `?compare=<id>` (default: the previous record). The repositories table links to each repository's analyses.

**Public API** (`features/public-api`, route `/public-api`) reads the API catalog (`/api/api-surface/*`). **Packages** shows totals and a table of every package (version, repository, exports, share documented, versions on record) filtered by name, description or repository; **Search** finds exports by name or doc text, optionally of one kind; **MCP for agents** shows the endpoint, the Claude Code command and `.mcp.json` snippet, the caller's tokens (create with a lifetime, the secret shown once, revoke) and usage: calls per day with failures, top tools, packages, people and clients, and recent calls; **Reports** lists the `api-surface` records. `?package=&version=&repo=` opens one package: a version picker, a link to its Markdown, facts (ref, repository, exports, documented, other repositories with the same package) and two tabs — **API** groups the exports of an entry point by kind with doc comments, declarations, source locations and import lines, filterable, 150 at a time; **Changes** diffs it with an earlier release (removed, changed with before and after, deprecated, added), with the semver warning when exports were removed without a major bump; **Used by** (`UsagesTabs.tsx`, from `/api/api-surface/usages/*`) shows the repositories using the package with their versions (green for the newest in use), the exports they use with kinds, props and members as bars, the exports no analyzed repository uses, and the code of the picked export, prop or member as snippets with line numbers; clicking a repository narrows everything to it; **Upgrade impact** picks an older release and lists what upgrading from it breaks (`breaking`, `check`, `deprecated`), with removed members and the affected code per repository. The header offers **Analyze past releases** with the API snapshot preselected. Helpers live in `lib/public-api.ts` and `lib/usages.ts`. A repository page's **Packages** tab (with `analyses:read`) lists the packages its newest `usages` record shows, with versions and counts, linking to each package's page.

**Dependencies** (`features/dependencies`) has two tabs. **Across repositories** reads `GET /api/dependencies`: cards for libraries, libraries in several versions, libraries a major version behind and usages behind the latest version; filters by name, drift (several versions, behind, major behind), ecosystem and dev dependencies; and two views. **Libraries** lists each library with a version bar colored by lag and expands into its usages (repository, workspace, kind, version, the record it comes from). **Matrix** puts libraries against repositories with the installed version in each cell. With `?repo=` both are limited to that repository's usages while lag still compares with the whole fleet. Libraries a fleet repository defines itself are marked `internal`, and their source version counts as the latest. **Graph reports** is the usual list of `depgraph` records. Helpers live in `lib/dependencies.ts`.

**Libraries** (`features/libraries`, sidebar Code → Libraries, `analyses:read`) shows the third-party library docs the server indexes for agents (design: [docs/library-docs.md](../../../docs/library-docs.md)). `/libraries?q=&ecosystem=` reads `GET /api/libraries`: totals, the last indexing run (when it finished, counts, an error, failed sources expandable with their messages), and a table of libraries — name with description, ecosystem, latest, indexed versions as chips, repositories using it, document sections, issues, a warning badge for sources whose last fetch failed, and when it was updated — filtered by name and ecosystem. **Reindex now** (`analyses:run`, global on the server) posts `POST /api/libraries/reindex`. When the server does not index libraries (`enabled: false`), the page explains the `libraries` setting instead. `/libraries/view?ecosystem=&name=&version=` reads `GET /api/libraries/:ecosystem/:name`: description, latest, repository and homepage links (http(s) only), library-wide source statuses; the versions table (version and tag, roles as chips with what each means, published date, deprecation message, repositories using it, per-source status chips with time and message on hover, `leaving` for versions out of the matrix); the documents of the newest version grouped by source; and a docs search over `GET /api/libraries/search` scoped to the library and optionally a version (`?version=`), each hit with its heading path, path, source, versions and a plain-text excerpt (never rendered as HTML or Markdown) linking to `url` when there is one. Both pages, and the **MCP for agents** tab of Public API, name the MCP tools agents use: `library_versions`, `search_library_docs`, `read_library_doc`, `library_changes`, `search_library_issues`, `library_source`. Helpers live in `lib/libraries.ts`.

`features/reports/ReportView.tsx` renders any report without knowing its kind: header (subject repo, ref, compared ref), metric cards with animated values and deltas colored by `better`, and sections as anchored cards with a scroll-spy table of contents. Blocks render through `features/reports/registry.tsx`, one file per block type in `features/reports/blocks/`:

| Block      | Renderer                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics`  | metric cards                                                                                                                                                                                                                                                                                                                                                                                   |
| `table`    | TanStack Table: header sorting, search, `groupBy`, unit-aware and delta cells, links, tone chips                                                                                                                                                                                                                                                                                               |
| `chart`    | Recharts bar, stacked bar, line, area, donut; tone or categorical colors                                                                                                                                                                                                                                                                                                                       |
| `treemap`  | Recharts Treemap with click drill-down, breadcrumb and an accessible list                                                                                                                                                                                                                                                                                                                      |
| `timeline` | collapsible `×N` groups for folded children, Motion layout animations                                                                                                                                                                                                                                                                                                                          |
| `graph`    | React Flow, dagre layered layout (`force` uses a grouped grid layout that never overlaps nodes), highlighted paths animated, minimap; capped at 250 nodes with a notice                                                                                                                                                                                                                        |
| `issues`   | callouts by tone                                                                                                                                                                                                                                                                                                                                                                               |
| `markdown` | safe subset, no raw HTML                                                                                                                                                                                                                                                                                                                                                                       |
| `changes`  | review-style diffs per proposed change: confidence and source chips, collapsible files with old/new line numbers, unified or split layout; when `applicable` and the principal has `analyses:run`, selection (incl. \"select all safe\") and a sticky bar to download or copy a patch or open a merge request via `POST /api/analyses/:id/changes`, with conflicts shown on the affected cards |

Blocks that act on their report read `ReportContext` (`features/reports/context.ts`), which the analysis page provides with the record id, whether the principal may apply changes and, for reports with `exclude` and a principal with `settings:write`, the repository and exclude targets; without it they render read-only. Table cells of `path` columns wrap after their slashes with the folder muted (`PathText`), so long paths no longer push the other columns out; with `exclude` each such cell gets an exclude button on hover that opens `ExcludeDialog`: choose the option (e.g. skip optimization or ignore entirely) and a glob from `excludeChoices` (the file with glob characters escaped, its extension in the folder, each parent folder, the name anywhere) or type one, and it is appended to the setting for that repository (`excludeEntry`: the entry naming the repository is extended, otherwise a new one starts from the winning broader value).

**Adding a block type:** add it to the model, write `blocks/<Type>Block.tsx`, register it in `registry.tsx` and add the type to `blockTypes` in `lib/analyses.ts`. The compiler refuses a registry or list that misses a type, and `registry.test.ts` checks they match. Unknown types from a newer server show a neutral placeholder.

## Design notes

- **Themes.** HeroUI themes switch on `.dark` / `data-theme` on `<html>`. The preference (system, light, dark) is stored in `localStorage` and applied by an inline script before first paint; `ui/theme.ts` keeps it in sync with `prefers-color-scheme`.
- **Look.** Shared with the docs site: warm near-black / paper backgrounds, amber accent, teal for success, hairline borders and Geist / Geist Mono. HeroUI tokens are overridden in `app.css` for both themes; keep them in step with `docs/src/styles/landing.css`. The mascot and capability icons come from [@holtkeeper/brand](../../../packages/brand/docs/README.md) through `ui/BrandIcon.tsx`; `Page` takes an `icon` for capability pages.
- **Sidebar.** Entries in `features/shell/nav.ts` carry a `section` (Overview, Security, Code, Delivery, Agents, Admin); `groupNav` lists them under those headings in that order and leaves out headings with no visible entry. A **Documentation** link to the docs site (`docsUrl`) sits at the bottom of the sidebar and the mobile drawer. `activeNav` picks the highlighted entry: the one whose path is the page's or a parent of it, and for `/analyses/$id` the page of the record's kind (`analysisPages`), so a report stays under **Test ids**, **Bundles** and so on. The active entry also sets the tab: the title becomes `<label> · Holtkeeper` and the favicon its `brand` icon from `@holtkeeper/brand` (the mascot when it has none or no entry is active).
- **People.** Users appear with their generated avatar (`ui/Avatar.tsx`, initials when the image fails) in the header, the users list and the activity log; activity resolves actor and subject ids through the `people` map of `/api/activity`. The account page rerolls the avatar (`PUT /api/me/avatar`).
- **Color.** Severity colors (`--sev-*`) and the categorical series (`--series-*`) have separate light and dark steps in `app.css`. Severity always comes with a text label, never color alone; languages keep a stable color slot everywhere.
- **Audit reports.** Findings go through TanStack Table for filtering (severity, language, package manager, free-text) and sorting, then are grouped Language → package manager → source file → package with `sourceInfo`, so every ecosystem renders the same way.
- **Motion.** Pages fade in, lists animate layout changes, headline numbers count up; Motion honours `prefers-reduced-motion`.
- **Keyboard.** Every control is a React Aria component or a native element; `/` focuses the findings search, a skip link jumps to content, Escape closes dialogs and the mobile drawer.
