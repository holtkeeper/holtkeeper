# Bundles

Part of the web app's [Quality](README.md#quality) docs.

**Bundles** (`/quality/bundles`, `features/bundles/`, `analyses:read`) is a `FleetTable` over `GET /api/bundles`: one row per app build or published package of every readable repository's newest bundle records, built from stored metrics only. Columns: target with its kind and repository (links to the hub's Quality › Bundles), release (package version, else the record's ref) and age, total JS and CSS gzip, the change against the previous measurement in bytes and percent, budget used (a bar, the state in words and `N% of budget`) and the initial gzip of the largest entrypoint. Budgets come from the `budgets` option of `analyzers.bundle` (target name or glob → maximum gzip bytes); a target is **near** from 90% of its budget and **over** above it.

The toolbar has the scope switch (_My teams_ folds other teams' targets into one row with their over-budget count), **Kind** (apps, packages) and **Budget** (over, build failed, near, within, no budget) filters; the header search filters by target or repository. The `Strip` counts targets (apps and packages), over budget, near budget, targets that grew since the previous release with the total growth, and failed builds. Without a sort rows go worst first (`worstFirst`: over budget, failed, near, then by budget used and size); every column sorts. **Measure now** (primary, `analyses:run`) queues the `bundle` analyzer, **Analyze past releases** (⋯) backfills old releases, **Configure** opens the `analyzers.bundle` options.

A row (click, J/K and ↵) opens `BundleSheet`: the record's short id, "3 of 41", the budget as the progress bar, **Measure now** and **Analyze past releases**, **Open as page** (the analysis record), facts (repository, release, age, total with its change, largest entrypoint) and underline tabs over `GET /api/bundles/report` and `GET /api/bundles/targets`:

- **Composition**: the report's overview (initial load per entrypoint, notable changes), the composition treemap and the assets, as read-only report blocks;
- **Entrypoints** and **Packages**: the report's sections of those names (a package target shows its archive here);
- **History**: total and per-entrypoint initial size over every measurement (gzip, brotli or raw; failed builds are gaps) and a table with the change of each; picking a point shows its report in the other tabs until **Back to newest**.

Search parameters (`parseBundlesSearch` in `lib/bundles.ts`): `repo` narrows to one repository, `q`, `kind`, `budget`, `sort`/`dir`; the sheet is `open` (repository) + `target`, with `tab` and the point as `version` (packages) or `analysis` (builds). The hub's Quality › Bundles (`BundlesRepoSection`) is the same table narrowed to the repository, its state kept in the component. Helpers (`bundleRows`, `filterBundleRows`, `bundleKpis`, `budgetState`, `sheetSections`, `chartRows`, `historyRows`) live in `lib/bundles.ts`.
