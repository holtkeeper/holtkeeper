# Knowledge: Guide, navigation and spaces

Part of the web app's docs ([README](README.md)). Notes and Learnings have their own page: [notes-learnings.md](notes-learnings.md). **Ask in chat** opens [Chat](chat.md).

## Routes and search parameters

`/knowledge/guide`, `/knowledge/notes` and `/knowledge/learnings` (`knowledge:read`) are one page, `KnowledgePage`. The tab is the path (`knowledgeTabOf`); the search parameters (`knowledgeSearch` in `lib/guide.ts`, the same shape as `webPaths.knowledge`) are:

- `space`: `all`, `group:<group>`, `family:<id>` or `repo:<forge>:<path>` (the Guide scope keys); missing or malformed means _All_. Switching tabs keeps it (the routes retain `space`).
- `section`: the open Guide section (`general`, `review`, `testing`, `testids`, `assets`, `commits`, `releases`); dropped when unknown.
- `note`: the open note, read by the Notes tab.

The header has the workspace crumb, then the trail of spaces from _All_ down to the current one (the segmented tabs name the tab, so the crumbs leave it out) (`spaceTrail`: All → team → family → repository; a repository's team is its first group, a family's the first group of a member), each step a link. The tabs carry the space's counts (Notes, Learnings waiting) from `GET /api/knowledge/counts`; the Notes count is the live notes the Notes table lists for the space. On the Guide tab **Effective prompt** toggles the inline panel; on Notes the primary action is **New note**; the ghost **Configure** (with `settings:read`) links per tab (`knowledgeSettingsLink` in `lib/settings-sections.ts`): Guide to Settings › Analyzers with the `guide` analyzer's sheet open, Notes to Settings › Policies at **Agent knowledge** (`knowledge.autoAccept`), Learnings to Settings › Analyzers with the `review` analyzer, whose reply threads learnings come from. The Guide's section policies stay editable in the section detail.

## Spaces sidebar

`SpacesSidebar`: _All repositories_, the scope switch, then teams with their families and repositories (`buildSpaceTree`). Each row shows the space's Guide sections plus notes as a quiet number and learnings waiting as a warning badge (`spaceCounts` over `GET /api/knowledge/counts`, which only holds spaces the viewer may read). A team lists five families and repositories, then "N more" (`foldList`). Under _My teams_ the other teams fold into one collapsed row "Other teams · N repositories" that expands in place (`SpaceTree.others`, `otherRepos`); without home groups nothing is listed or folded and `NoTeamsState` takes the list's place. A group picked in the switch lists only that team, nothing folded. Every count of the switch counts repositories: _My teams_ those in a home team, _All I can see_ all of them, each group its own. _Not in a team_ shows on _All I can see_ only. With `settings:write`, suggested families show their similarity (the lowest pairwise share of dependencies, `similarityText`), their stack and the paths of up to four members (then "+N more") with **Confirm**, **Edit** and **Dismiss**; **Edit** opens `FamilyDialog` with the similarity, framework, toolchain and shared dependencies of the suggestion.

## Guide

`GuideTab` reads the space's sections (`GET /api/guide?scope=`) and, for a repository, its chain (`GET /api/guide/chain?repo=`). On Knowledge it opens with the space's identity (name, kind, the forge for a repository) and an _Inherits from_ row linking each broader space of `spaceTrail`; the hub's and group page's Guide leave that header out. A summary line counts sections in use, team rules, learned rules and generated proposals waiting, and says whether the viewer may edit. For a repository with no tests by design (`RepoSummary.noTests`, setting `repo.tests`) the Testing row carries a **No tests by design** tag and, when open, a notice that agents never read it and the generator skips it.

The **sections table** (`sectionRows`) has one row per section: the layers that give it text as letters (O All repositories, G Group, F Family, R Repository, L Learned, A Generated; repository files are D; `layerKinds`, `tableLayerKinds`), the number of rule lines this space sets, the version, the last edit and a status (_Proposal waiting_, _Set here_, _Inherited_, _Not set_). Clicking a row opens it (`?section=`); clicking it again closes it.

`SectionDetail` shows the open section:

- **Layers in agent reading order.** In a repository space they are the chain's layers for that section (`GET /api/guide/chain?repo=&section=`), numbered as the agent reads them: repository files, this repository, family, teams (several, in config order), all repositories, learned rules, policies, generated text, notes. Each shows its characters and _cut_ when the budget shortened it. `layerSlots` keeps an editable slot for this repository's rules and, in generated sections, for generated text even when the chain has none (numbered "–"). Inherited layers render their text (`layerBody`) with a link to their space.
- **The 12k budget** (`BudgetBar`) of the whole prompt the section goes into (a review reads general, review, testing, testids and assets together): used of 12,000 characters, about how many tokens, and Human, Generated, Notes and Free (`budgetSegments`), with the resolver's warnings.
- **Repository files**: `REVIEW.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` as read from the default branch (`GET /api/guide/repo-files`), read-only, with line counts and the default branch commit they were read at.
- **This space's rules**: Markdown with "edited by"; editing saves with the section version (`PUT /api/guide/section`, 409 when someone saved first). **History** lists revisions inline with **Restore**.
- **Learned rules** (with _N candidates in Learnings_ linking to the space's waiting candidates while any wait), and **Steering** for General, Testing and Test ids (generator only, never sent to agents).
- **Generated**: the proposal and the accepted text with version, model, cost, time, commit and job; **Accept** (`POST /api/guide/section/accept` with the shown `inputHash`), **Reject** (`POST /api/guide/section/reject` with the same `inputHash`), **Decide in Inbox**, **Regenerate** with an extra prompt (`analyses:run`), and **Compare** (`GeneratedCompare`): any two stored versions from `GET /api/guide/generated/history` side by side or unified (`lineDiff` into `FileDiffView`).
- **Policy**: the section's setting entries made for the space (`PolicyBlock`) for Test ids, Assets and Commits.

Outside repository spaces the detail lists this space's rules, a pointer to _All repositories_ (in team and family spaces), its learned rules and steering, numbered in the resolver's order; the 12k budget is per repository.

## Effective prompt

`EffectivePromptPanel` (inline above the tab body, and in the repository hub) shows exactly what one task of a repository gets (`GET /api/guide/preview?repo=&task=`), the repository's rules files read from the forge first: a repository of the space, the task (Review, Chat, Release notes, Agent task), the budget bar, **Copy text**, **Ask in chat** (creates a chat thread with the repository in `contextRepos` and opens it) and underline tabs Blocks, Full text and Warnings. `EffectivePrompt` is the compact form the Inbox uses.

## Repository and group hubs

`ScopeGuide` puts the same `GuideTab` (section in local state) into the hub's Knowledge tab and the group page, with the effective prompt for a repository and a link to its Notes and Learnings.
