# @holtkeeper/web

The Holtkeeper admin panel: dashboards, audit reports, credentials, settings, users and the activity log. A single-page React app that talks only to the server's JSON API (`/api/*`) and auth endpoints (`/auth/*`). The server serves the built files from `apps/web/dist`.

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
    scope.ts          scope description, normalisation, pattern validation
    schema.ts         JSON Schema → setting editor kind
    schema-form.ts    JSON Schema → form fields (objects, records, lists, variants, $ref)
    severity.ts, repo.ts, theme.ts
  ui/                 thin wrappers over HeroUI and shared visual pieces
  features/<area>/    one folder per page: shell, auth, dashboard, audits, repos, analyses,
                      reports, credentials, settings, access (Scope/Grants editors), users, activity
```

## API client

Pages never call `fetch`. `api/endpoints.ts` maps every endpoint to a typed function using the shared types from `@holtkeeper/api` (types and browser-safe helpers only; no runtime code from other packages). `api/queries.ts` wraps them in hooks; mutations invalidate the affected query keys. Errors arrive as `ApiError` with the HTTP status; a 401 anywhere refetches `/api/me`, which shows the sign-in page.

## Access in the UI

`lib/access.ts` `can(principal, action)` only asks whether any grant names the action (or `*`). It decides which navigation entries and buttons to show; the server still checks the exact scope on every request, and pages show "No access" on a 403.

## UI wrappers

Everything from `@heroui/react` is imported in `src/ui/` only. Pages use `Button`, `Panel`, `Dialog`, `TextField`, `Select`, `Switch`, `Checkbox`, `Segmented`, `MultiToggle`, `Tabs`, `Tooltip`, `SearchInput`, `notify` and friends from `ui/index.ts`, so replacing the component kit means rewriting `src/ui/` and nothing else. Wrappers expose small, explicit props rather than passing HeroUI props through.

## Analyses and reports

Analyses (`changelog`, `bundle`, `depgraph`, …) all produce the universal `Report` from `@holtkeeper/report`. The sidebar has **Releases**, **Bundles**, **Dependencies** and **Code quality** (shown with `analyses:read`); each lists records of its kind per repository with trends of its preferred metrics (gzip/size for bundles, issues/coverage for quality; see `analysisPages` in `lib/analyses.ts`). `/analyses/$id` renders the record with `ReportView` and a "compare with" picker that sets `?compare=<id>` (default: the previous record). The repositories table links to each repository's analyses.

`features/reports/ReportView.tsx` renders any report without knowing its kind: header (subject repo, ref, compared ref), metric cards with animated values and deltas colored by `better`, and sections as anchored cards with a scroll-spy table of contents. Blocks render through `features/reports/registry.tsx`, one file per block type in `features/reports/blocks/`:

| Block      | Renderer                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics`  | metric cards                                                                                                                                                                                                                                                                                                                                                                                   |
| `table`    | TanStack Table: header sorting, search, `groupBy`, unit-aware and delta cells, links, tone chips                                                                                                                                                                                                                                                                                               |
| `chart`    | Recharts bar, stacked bar, line, area, donut; tone or categorical colors                                                                                                                                                                                                                                                                                                                       |
| `treemap`  | Recharts Treemap with click drill-down, breadcrumb and an accessible list                                                                                                                                                                                                                                                                                                                      |
| `timeline` | collapsible `×N` groups for folded children, Motion layout animations                                                                                                                                                                                                                                                                                                                          |
| `graph`    | React Flow, dagre layered layout (`force` uses a grouped ring layout), highlighted paths animated, minimap; capped at 250 nodes with a notice                                                                                                                                                                                                                                                  |
| `issues`   | callouts by tone                                                                                                                                                                                                                                                                                                                                                                               |
| `markdown` | safe subset, no raw HTML                                                                                                                                                                                                                                                                                                                                                                       |
| `changes`  | review-style diffs per proposed change: confidence and source chips, collapsible files with old/new line numbers, unified or split layout; when `applicable` and the principal has `analyses:run`, selection (incl. \"select all safe\") and a sticky bar to download or copy a patch or open a merge request via `POST /api/analyses/:id/changes`, with conflicts shown on the affected cards |

Blocks that act on their report (only `changes` so far) read `ReportContext` (`features/reports/context.ts`), which the analysis page provides with the record id and whether the principal may apply changes; without it they render read-only.

**Adding a block type:** add it to the model, write `blocks/<Type>Block.tsx`, register it in `registry.tsx` and add the type to `blockTypes` in `lib/analyses.ts`. The compiler refuses a registry or list that misses a type, and `registry.test.ts` checks they match. Unknown types from a newer server show a neutral placeholder.

## Design notes

- **Themes.** HeroUI themes switch on `.dark` / `data-theme` on `<html>`. The preference (system, light, dark) is stored in `localStorage` and applied by an inline script before first paint; `ui/theme.ts` keeps it in sync with `prefers-color-scheme`.
- **Color.** Severity colors (`--sev-*`) and the categorical series (`--series-*`) have separate light and dark steps in `app.css`. Severity always comes with a text label, never color alone; languages keep a stable color slot everywhere.
- **Audit reports.** Findings go through TanStack Table for filtering (severity, language, package manager, free-text) and sorting, then are grouped Language → package manager → source file → package with `sourceInfo`, so every ecosystem renders the same way.
- **Motion.** Pages fade in, lists animate layout changes, headline numbers count up; Motion honours `prefers-reduced-motion`.
- **Keyboard.** Every control is a React Aria component or a native element; `/` focuses the findings search, a skip link jumps to content, Escape closes dialogs and the mobile drawer.
