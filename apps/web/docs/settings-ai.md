# Settings › AI

Part of the web app's [Settings](README.md#settings) docs.

Route `/settings/ai`, body `features/settings/sections/AiSection.tsx`, endpoints and hooks in `api/settings-ai.ts`. Server side: [apps/server/docs/integrations.md](../../server/docs/integrations.md).

From top to bottom:

- **Summary line** (`AiStrip` in `features/ai/AiSettings.tsx`): the provider agents run on (the AI credential whose `usedBy` names `llm.provider`), this week's spend against the budget, runs, failed runs and the cache hit ratio. Figures the viewer may not read are left out; the line is hidden when none is left.
- **Providers** (`features/credentials/Credentials.tsx`, `credentials:read`): one card per AI provider credential with kind, endpoint, an _Agents use it_ tag, expiry, scope, rotation, this week's spend and runs (usage grouped by `provider`, which is the credential name), the last use (`lastUsedLabel`) and its status (`credentialStatus`), then Models, Test, Rotate, Edit and Delete. _Add provider_, the section header's primary action, opens the credential dialog.
- **Budgets** (`BudgetsPanel`, `ai:read`): from `GET /api/ai/budget`.
  - The broadest readable budget: spend, percent and status (`budgetState`), a meter split by feature (`featureBreakdown`, darkest first, Other lightest) with the warning line at `warnPercent` and the stop line at the weekly limit (`budgetMarks`), a legend per feature and the pace line from the forecast.
  - The global budget editor (`BudgetEditor` from `features/ai/BudgetCard.tsx`, also on Ops › AI spend) for a global `settings:write`: weekly limit, amount kept for people, Warn at and Block or Warn. Past Warn at, people who may change the budget get one Inbox item that week.
  - **Caps table**: scoped `llm.budget` entries with kind (Group, Repository, Mixed), cap, spend, a used bar and status (`capStatus`), then one read-only row per feature with its spend and its share of the org budget: features have no caps of their own. _Add cap_ jumps to the `llm.budget` entries below.
- **Provider and budget settings**: the section's setting entries per scope (`llm.provider`, `llm.budget`, `agent.tools` under Advanced). A scoped `llm.budget` entry is a cap.
- **Advanced: agent tools** (`AgentToolsPanel`, `ai:read`): the read-only registry from `GET /api/ai/tools` with toolset, who gets each tool (`toolUsers`: Reviews, Chat, Agent tasks, MCP clients) and whether it writes.

## Features

`lib/ai-features.ts` maps task kinds to product features: Reviews (`review`, `triage`), Agent tasks (`write-task`, `fix`, `port`, `propagate`, `upgrade`, `propagate-fix`, `tests`), Chat (`chat`, `chat-summary`), Guide and learnings (`guide`, `learning`, `library-digest`), Release notes (`release-notes`), Other (anything else, and runs without a kind). `featureBreakdown` sums `AiBudgetOverview.byFeature` per feature with each share of the total, Other always last; `featureItems` does the same for usage buckets (Ops › AI spend, Runs).

## Budget warning in the Inbox

A `budget` Inbox item (`InboxBudgetItem`) has nothing to approve or reject. Its sheet (`features/ai/BudgetWarning.tsx`) shows the week, spend, warning line, budget and scope, links here, and _Acknowledge_ snoozes it until the week ends (`dueAt`). The Inbox segment is _Budget_.
