# QA

Part of the web app's [Releases](README.md#releases) docs.

Releases › QA (`features/qa`) shows testers what changed under each task (ticket key) across repositories. Helpers live in `lib/qa.ts`; the server side is described under [QA tasks](../../server/docs/README.md#qa-tasks).

## Task list

`/releases/qa` (`QaTasksPage`) reads `GET /api/qa/tasks?days=` (`useQaTasks`, every 3 s while the server still reads repositories, else every 2 minutes). The toolbar has the scope switch (tasks carry the owner teams of their repositories; other teams fold as on other lists), the `/` search over key, title, repository and author (`filterTasks`) and the period: 7, 30 or 90 days, remembered in local storage.

A notice says how many repositories are read while some are pending, another names repositories whose read failed. The table has one row per task, newest change first: the key with its title (the tracker's, else one taken from merge request and commit titles) and tracker status, up to two repositories (`+N` for more), the merged, open and direct changes (`countsText`), the last change and the summary state (_Summary_ or _Outdated_). A row opens the task. The footer counts tasks and the changes without a task, which are not listed.

## Task

`/releases/qa/$key` (`QaTaskPage`) reads `GET /api/qa/task?key=` (`useQaTask`, again every 3 s while repositories are pending). It shows:

- the title, key, issue type and status, and a link to the tracker;
- **Summary for testing**: without one, **Summarize**; with one, its sections (the verdict with its reason, overview, what changed, test cases with priority, steps and the expected result, ideas per kind of testing, autotest ideas with the test attribute values they could use, risks and open questions), who wrote it when with which model, and **Regenerate**. When changes came, went or moved on since, a warning lists them (`stalenessText`, `changeLabel`). Both buttons run `POST /api/qa/summary` (`useSummarizeQaTask`) and are off with the server's reason (`summarizeHint`: no `analyses:run` or no AI agent);
- **Test attributes** added and removed over all changes, merged per file, a later change undoing an earlier one (`testIdSummary`);
- one panel per repository (`changesByRepo`) with its changes: the kind (_Merged_, _Open_, _Direct commit_, _Local merge_; `changeKinds`), a _No review_ mark for direct commits and local merges, _Draft_, the id linking to the forge, the title, target and source branch, authors, time, commit count, files with line counts and a collapsible file list.

A key no readable change names shows an empty state.

Agents read the same tasks over MCP with `qa_tasks` and `qa_task` once a token's owner turns on **QA tasks** in Account › Connect agents (off by default); summaries are written only here.
