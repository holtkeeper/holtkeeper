# Settings › AI

Part of the web app's [Settings](README.md#settings) docs.

Route `/settings/ai`, body `features/settings/sections/AiSection.tsx`, endpoints and hooks in `api/settings-ai.ts`. Server side: [apps/server/docs/integrations.md](../../server/docs/integrations.md) and, for semantic search, [Semantic search](../../server/docs/README.md#semantic-search).

From top to bottom:

- **Summary line** (`AiStrip` in `features/ai/AiSettings.tsx`): the provider agents run on (the AI credential whose `usedBy` names `llm.provider`), this week's spend against the budget, runs, failed runs and the cache hit ratio. Figures the viewer may not read are left out; the line is hidden when none is left.
- **Providers** (`features/credentials/Credentials.tsx`, `credentials:read`): one card per AI provider credential with kind, endpoint, an _Agents use it_ tag, expiry, scope, rotation, this week's spend and runs (usage grouped by `provider`, which is the credential name), the last use (`lastUsedLabel`) and its status (`credentialStatus`), then Models, Test, Rotate, Edit and Delete. _Add provider_, the section header's primary action, opens the credential dialog.
- **Budgets** (`BudgetsPanel`, `ai:read`): from `GET /api/ai/budget`.
  - The broadest readable budget: spend, percent and status (`budgetState`), a meter split by feature (`featureBreakdown`, darkest first, Other lightest) with the warning line at `warnPercent` and the stop line at the weekly limit (`budgetMarks`), a legend per feature and the pace line from the forecast.
  - The global budget editor (`BudgetEditor` from `features/ai/BudgetCard.tsx`, also on Ops › AI spend) for a global `settings:write`: weekly limit, amount kept for people, Warn at and Block or Warn. Past Warn at, people who may change the budget get one Inbox item that week.
  - **Caps table**: scoped `llm.budget` entries with kind (Team, Paths, Mixed), cap, spend, a used bar and status (`capStatus`), then one read-only row per feature with its spend and its share of the org budget: features have no caps of their own. _Add cap_ jumps to the `llm.budget` entries below.
- **Semantic search** (`SemanticSearchPanel` in `features/ai/SemanticSearch.tsx`, anchor `#setting-knowledge.embeddings`): the global `knowledge.embeddings` setting in a block of its own (`blockSettingKeys` keeps it out of the entry lists below; it is homed in this section, so settings search and System do not list it elsewhere).
  - **Status line** (`knowledge:read`, `GET /api/knowledge/embeddings`, `useKnowledgeEmbeddings`, polled every 5 s while indexing): a state tag (Off, Indexing, Ready, Error), notes indexed of total, the model and the last run (`embeddingsStatusLine` in `lib/embeddings.ts`), then the error with "Search falls back to full text meanwhile".
  - **Form** (global `settings:write`; `embeddingsDraft`, `parseEmbeddingsDraft`, `sameEmbeddingsDraft`): an enable switch; once on, the credential (the AI provider's, or an `ai-sdk` credential; a text field without `credentials:read`), the model from `GET /api/knowledge/embeddings/models?credential=` (`useEmbeddingModels`, options by `embeddingModelOptions` with dimensions and the price per 1M tokens from `formatEmbeddingPrice`; a model the endpoint does not list stays first as _not listed_; a text field when nothing is listed, with the endpoint's error) and optional dimensions (1–8192). Saved with `PUT` of the global entry; Cancel restores the stored value.
  - **Reindex** (header action, global `settings:write`, when not off): confirms, then `POST /api/knowledge/embeddings/reindex` (`useReindexEmbeddings`) drops every vector and embeds again.
- **Provider and budget settings**: the section's setting entries per scope (`llm.provider`, `llm.budget`, `agent.tools` under Advanced). A scoped `llm.budget` entry is a cap.
- **Advanced: agent tools** (`AgentToolsPanel`, `ai:read`): the read-only registry from `GET /api/ai/tools` with toolset, who gets each tool (`toolUsers`: Reviews, Chat, Agent tasks, MCP clients) and whether it writes.

## Features

`featureOf` from `@holtkeeper/ai-usage/features` maps task kinds to product features: Reviews (`review`, `triage`), Agent tasks (`write-task`, `fix`, `port`, `propagate`, `upgrade`, `propagate-fix`, `tests`), Chat (`chat`, `chat-summary`), Guide and learnings (`guide`, `learning`, `library-digest`), Releases and QA (`release-notes`, `qa-notes`), Vulnerability triage (`security-triage`), Other (anything else, and runs without a kind). `featureBreakdown` in `lib/ai-features.ts` sums `AiBudgetOverview.byFeature` per feature with each share of the total, Other always last; `featureItems` does the same for usage buckets (Ops › AI spend, Runs).

## Budget warning in the Inbox

A `budget` Inbox item (`InboxBudgetItem`) has nothing to approve or reject. Its sheet (`features/ai/BudgetWarning.tsx`) shows the week, spend, warning line, budget and scope, links here, and _Acknowledge_ snoozes it until the week ends (`dueAt`). The Inbox segment is _Budget_.
