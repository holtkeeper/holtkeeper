# Knowledge: Rules, Learnings and the effective prompt

Part of the web app's docs ([README](README.md)).

## Routes

`/knowledge/rules` and `/knowledge/learnings` (`knowledge:read`) are one page, `KnowledgePage` in `features/knowledge`, with the two as the header's tabs. Every other `/knowledge/*` path, `/knowledge` included, redirects to `/knowledge/rules`. Search parameters (`knowledgeSearch` in `lib/rules.ts`):

- `rule`: the rule open in its sheet (Rules tab).
- `learning`: the learning open in its sheet (Learnings tab).
- `prompt`: the effective prompt panel is open (Rules tab); a `forge:path` value picks its repository.

The header's ghost **Configure** opens the Knowledge settings sheet (`useConfigure` over `pageSettingKeys.knowledge`: `analyzers.rule-miner`, `commits.conventions`, `assets.policy`, `analyzers.testids`). The learning lifecycle settings (`learnings.approvalDelayDays`, `learnings.expiryDays`) live in Settings › Policies.

## Rules

`RulesTab` reads `GET /api/rules?team=&repo=&text=` (`useRules`) with a **Team** and a **Repository** filter and a debounced text search. One row per rule: title (and its description when it is offered on request), scope in words (`ruleScopeLabel`: _All repositories_, _Team Widgets_, patterns in mono), how it applies (`activationOf`: its file globs, _Always_ or _On request_), agents (`agentsLabel`: _All_ or the picked runs), version and the last edit. **New rule** (with `knowledge:write` and `canCreate`) opens the form.

`RuleSheet` (`?rule=`, J/K step through the list) shows the Markdown body and where it applies (scope, files, agents, description, Always apply, the `rule:<id>` citation, who wrote and edited it), and a **History** tab (`GET /api/rules/:id`, `ruleVersions`) with **Restore** on earlier versions (a `PUT` of that version's content against the current version, `restoreRuleInput`). The ⋯ menu has **Edit** and **Delete** (confirmed) when the rule's `canEdit` is set.

`RuleEditor` edits title, Markdown body (`MarkdownEditor` with Write/Preview), scope (`ScopeEditor`: everything, teams, repository patterns), file globs, agents (Review, Agent task, Chat, Release notes; none means all), description and **Always apply** (only with a description). `ruleDraftProblems` blocks saving without a title, a body or a scope. A save of an edit sends the version the editor started from (`ruleInputOf(draft, version)`); a 409 (`isVersionConflict`) shows a notice with **Reload**, which refetches the rule and reopens the editor on it, dropping the edits.

## Effective prompt

`EffectivePromptPanel` reads `GET /api/rules/effective?repo=&agent=&files=` (`useEffectiveRules`): a repository picker (on Knowledge) or a fixed repository (in the hub), the run (`ruleAgents`) and an optional touched files field (comma or line separated, `parseFiles`, debounced). It shows used of total characters with a token estimate and the caps for rules files and learnings, **Copy text**, then underline tabs: **Blocks** (every block in prompt order with its title, layer and source, `blockSubtitle`, its characters as `chars / fullChars`, and _cut_ or _left out_), the rules offered on request under them, **Full text** and **Warnings**. Knowledge's **Effective prompt** button toggles it (`?prompt=`); the repository hub's Knowledge tab always shows it.

## Learnings

`LearningsTab` reads `GET /api/learnings?status=&origin=&repo=&text=` (`useLearnings`) with a **Status** filter (pending and active at first, `defaultLearningStatuses`), **Origin**, **Repository** and a debounced text search, and a strip with the pending (linking to the Inbox's Learnings), active and expiring-within-14-days counts of the list (`learningTotals`). One row per learning: text with its file globs, scope, origin (`originLabel`), sources, uses · acted on, votes and a status tag with when it activates or expires (`learningTiming`); pending rows of learnings the viewer may edit carry **Approve** and **Reject** (`POST /api/learnings/:id/approve|reject`).

`LearningSheet` (`?learning=`) shows reason, scope and files, agents, uses, votes, when it was last confirmed and the `learn:<id>` citation, then its sources (`sourceLabel`, linking to the merge request notes) and who decided or edited it. Quiet actions: **Approve** and **Reject** for a pending learning, **Reject** for an active one; the ⋯ menu has **Edit** (`LearningEditor`: text, reason, scope, files, agents; a `PATCH` that clears emptied fields with `null`, `learningPatchOf`) and **Delete** (confirmed). **New learning** (with `knowledge:write`) opens the same editor; `POST /api/learnings` answers `merged` when the text repeats an existing learning, which the toast says.

## Elsewhere

- The repository hub's **Knowledge** tab (`RepoKnowledgeTab`) shows the repository's effective prompt, the rules whose scope covers it and its pending and active learnings (`ScopedRules`, `ScopedLearnings` in `features/knowledge/ScopedKnowledge.tsx`).
- The team page's **Knowledge** tab lists the rules `GET /api/rules?team=` returns for the team.
- The Inbox shows pending learnings; see [README](README.md#inbox).
- Chat chips of cited rules and learnings (`rule:<short id>`, `learn:<short id>`) open them here (`citationOf` in `lib/chat.ts`).
