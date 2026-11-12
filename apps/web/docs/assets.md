# Assets and media

Part of the web app's [Quality](README.md#quality) docs.

## Assets

**Assets** (`/quality/assets`, `features/assets/AssetsPage.tsx`, `analyses:read`) reads the paged, filtered `GET /api/assets` (`useAssets`, an infinite query; **Load more files** fetches the next page from `nextCursor`). The body (`AssetsFiles`) is one `FleetTable` in the order of the other Quality tabs: the toolbar, then the strip (`strip`) and By kind (`stripExtra`), then the files. It shows:

- a summary strip over the repositories in scope (`assetsKpis`, from the server's summary, so it does not follow the status, kind and format filters of the paged rows): asset weight and how many repositories, potential saving and its share, files checked, errors, warnings, duplicate bytes, exceeded budgets and the weight change against the previous records (`trendText`);
- **By kind**: a bar of bytes per kind in stable series colors (`kindColor`, `kindLabel`, display order `assetKinds`) and the repositories over a budget;
- a `FleetTable` of files with the scope switch (_My teams | All I can see_, other teams folded), one row per file (`assetTableRows`: the page items with their repository's groups, key `forge:path|file`): path and `rowMeta`, repository (linking to the hub's Quality › Assets), format, size, the first two problems as tags (`problemLabel`, `severityTone`) with their messages, the potential saving with a bar (`savingPercent`) and the best conversion, and **Optimize** for images the optimizer can work on (`canOptimize`), otherwise **Details** (the analysis record). The toolbar has the status switch (**Breaks the policy**, **Any saving**, **Everything**), single-choice **Kind** and **Format** filters (`singleChoice`; groups come from the scope switch's picker) and the sort (severity, saving, size). The header's search filters the loaded rows in the browser (`searchAssetRows`: every word against repository, path and format), since the API has no text filter.

Rows with a checkbox can be selected; **Optimize N selected** opens the optimizer on the selection, **Optimize** or a click on a row on every optimizable row shown, and J/K step through that queue ("3 of 16"). The header's primary **Optimize an image** opens it on a blank file, with a repository picker unless the page is narrowed; **Configure** edits `analyzers.assets`, and "⋯" runs the analyzer.

Search parameters (`parseAssetsSearch`, `toAssetsQuery`): `repo` (`forge:path`, shown as a removable filter), `status` (default `policy`), `kind`, `format`, `problem`, `sort` (default `severity`) and `q`. Everything but `q` goes to the server.

**Asset policy** below the table (`AssetsPolicyCard`, read-only lines from `policyLines`, a link to the Guide's prose rules and **Edit**, which opens `assets.policy` in the settings sheet with `settings:read`). Narrowed to a repository (`?repo=forge:path`, or the hub section) the body drops the scope switch, the repository column and folding, and its empty state offers **Run assets**; the policy card shows that repository's effective policy and source (`GET /api/assets/repo`, `policySource`). Otherwise it shows the fleet's policy from `GET /api/settings` (`fleetPolicy`: the entry for every repository filled from the setting's default by `withPolicyDefaults`, else the default, and how many group or repository entries override it, `overridesText`); viewers without `settings:read` are asked to narrow to a repository.

The hub's **Quality › Assets** section (`AssetsRepoSection`) is the same body narrowed to one repository, with its filters in local state, the record's age and sha, a sparkline of total bytes over recent records in the strip (`GET /api/assets/repo` `trend`), **Open in Quality**, and the repository's policy card with **Analyzer options** and its `assets.policy` entries edited with the setting's form (`PolicyBlock`). `?tab=quality&section=assets&file=&ref=` on the hub opens the optimizer on that file, which is where review comments link (`webPaths.repo`); it opens even before the repository has an assets record.

## Media optimizer

`MediaSheet` (`features/media/`) is a `SideSheet` that works one step at a time (`mediaSteps`, `stepState`, drawn as a four-part stepper):

1. **Configure**: repository (when not fixed), image path, ref, formats, widths, densities, effort and quality (`validateMediaDraft`, `toVariantsInput`), then **Generate variants** (`POST /api/media/variants`, `analyses:read`; 503 reads as "not set up"). Once generated the step collapses to labelled lines (`configSummary`) with **Edit**.
2. **Choose variants** (`MediaVariants`): original size and best saving, a table of offered variants (`offeredVariants`) with a checkbox, thumbnail, size, saving tag (`savingsTone`, `formatSavings`) and an editable repository path. Variants start chosen unless their suggested path already exists at the ref (`initialSelection`, from the response's `exists`); a chosen variant still at an existing suggested path is a conflict (`conflictIds`, `pathError`) with a warning note. The optimized SVG, or a variant made at the original's own path, can replace the original (`replacementOf`). `selectionText` sums what is chosen; **Next** stays disabled while `deliverBlocker` names a reason.
3. **Markup**: the response's snippets per framework (`snippetLabel`) with copy buttons.
4. **Deliver** (`analyses:run`): an optional merge request title (placeholder `mediaTitle`), **Open merge request** or **Download ZIP** (`POST /api/media/apply`), then the merge request link and any files the forge refused to write.

Back and Edit return to earlier steps without losing the chosen variants; each file in a queue starts fresh.
