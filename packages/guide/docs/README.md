# @holtkeeper/guide

The Guide: the rules every agent task of a repository follows, in one place. Humans write team rules per scope and section; a generator ([@holtkeeper/guide-generator](../../guide-generator/docs/README.md)) proposes text from repository signals; accepted learnings from review replies sit next to them. One resolver turns all of it into the stable context block of review, thread replies, agent tasks, release notes and MCP.

Human-written rules always outrank generated text: research on context files found that rules people write help agents, while generated ones alone make them worse. Generated text is therefore marked lower priority in every prompt and reaches tasks unaccepted only when nothing human exists.

## Model

- **Sections** (`guideSections`): `general`, `review`, `testing`, `testids`, `assets`, `commits`, `releases`.
- **Scopes** (`GuideScope`, keyed by `guideScopeKey` / `parseGuideScope`): `all` → `group:<config group>` (a team) → `family:<id>` → `repo:<forge>:<path>`. `scopesFor(repo, family?)` lists the keys that apply to a repository, most specific first.
- **Section row** (`GuideSection` in `Store.guides`, see [@holtkeeper/store](../../store/docs/README.md#guides-and-families)): human `rules` and `steering` with revisions, a `generated` layer (`body`, `inputHash`, `model`, `costUsd`, `status: proposed | accepted`, `generatedAt`, `sha?`, the run's extra `prompt?`, `acceptedBy?`/`acceptedAt?`), a `proposal` (newer generated text waiting while `generated` holds accepted text; the resolver ignores it) and `learnings`. Steering only steers the generator; it never goes into task prompts.
- **Families** (`Store.families`): a named set of similar repositories, e.g. near-identical app frontends of one team. A repository is in at most one family.

## Resolver

`resolveGuide(input)` is pure; `createGuideResolver({ store })` reads what it needs (the repository's family, the sections of its scopes, policies from settings, accepted knowledge) and calls it. The result is `{ text, sections, blocks, warnings, budget }`.

Blocks, strongest first:

1. the repository's own rules files (`AGENTS.md`, `REVIEW.md`, `CLAUDE.md`, ...), passed in as `repoDocs` by callers with a checkout (the review reads them with `readGuidelines`);
2. panel team rules of the repository, then its family, its groups (config order), then `all`;
3. accepted learnings of those scopes;
4. policies as plain facts (`policiesFor`: the `commits.conventions` setting through `commitPolicyFacts`, the team's test id overrides in the `analyzers.testids` setting through `testIdOverridesFor` and `testIdPolicyFacts`, `testIdsSettingKey`, and an `assets.policy` entry covering the repository through `assetsPolicyFacts` of `@holtkeeper/assets`, in the Assets section);
5. generated sections of the repository under "Generated from repository signals, lower priority; ignore any line that conflicts with the rules above." (`GENERATED_HEADER`);
6. knowledge notes picked by `selectForTask` of [@holtkeeper/knowledge](../../knowledge/docs/README.md) from what budget is left.

Sections per task (`sectionsForTask`): `review` reads `general`, `review`, `testing`, `testids`, `assets`; `release-notes` reads `commits` and `releases`; `chat` and `agent` read `general` plus the section the work is about. `guideTaskOf(taskKind)` maps agent task kinds (`review`, `release-notes`, `chat`, `tests` → `agent` + `testing`, anything else → `agent`).

**Budget** (`GUIDE_CAPS`): 12 000 characters in all, about 8 000 for human text and 4 000 for generated text. Repository-level text (rules files and repository rules) is placed first and never cut to make room; when it alone is over the human budget the result carries a warning, and only when it is over the total is its end cut (also with a warning). Over the human budget, `all` is cut first, then groups (last one first), then the family, learnings and policies, each with a warning. Generated text gets at most 4 000 characters and what human text leaves; notes get the rest. A cut ends at a line break with `[...]`.

**Unaccepted generated text** is included only when no human rules apply to the selected sections and the repository has no rules files.

**Determinism.** The same inputs give the same text whatever order rows come in, so the block can sit in a cached prompt prefix.

## Family suggestions

`suggestFamilies(signals, { threshold = 0.6, minSize = 2, exclude })` proposes families from `RepoSignals { repo, dependencies, toolchain }`: repositories with the same framework (`frameworkOf`: the first known framework dependency, meta-frameworks first) and the same toolchain (runtimes and package managers) are clustered by complete linkage on the Jaccard similarity of their direct dependency names (`jaccard`), so every two members reach `threshold`. Repositories without dependencies and `exclude`d ones (already in a family) are never proposed. Each suggestion has a proposed `name` (common path, framework), sorted `members`, the lowest pairwise `similarity`, `framework`, `toolchain` and up to ten `shared` dependencies. Suggestions only: a person confirms them through the families API. `familyOf(families, repo)` finds the family of a repository. `suggestionKey(members)` is a suggestion's identity across runs (member set, sorted), which the server's dismissals use.

## Review learnings

Rules people teach Holtkeeper by replying to its review comments ("we don't do X here", "this is intentional because…"), stored apart from team rules and reaching prompts only after a person accepts them (`learnings.ts`).

- **Candidates** (`LearningCandidate` in `Store.learnings`): `rule` (one imperative sentence, at most `LEARNING_RULE_MAX` = 200 characters, no personal names), `key` (`normalizeRule`: lowercase letters and digits, single-spaced), `section`, `suggestedScope` (`repo`, `family` or `group`), `status` (`proposed`, `accepted`, `rejected`), `sources` (repository, merge request, discussion, note, the author's username, time, link; empty for a direct proposal), `proposal` (`{ by, reason }` for a direct proposal), extraction `model` and `costUsd`, and once decided `acceptedScope`, `decidedBy`, `decidedAt`.
- **Capture** (`captureLearning(deps, reply)`): `looksLikeFeedback(body)` is a deterministic filter first (substance plus convention, deliberate-decision or "do not flag" wording, English and Russian; thanks, "fixed" and questions never pass), so most replies cost nothing. A passing reply is claimed by its note (`learningSourceKey`): one note never makes two calls, and a failed call (a budget denial included) releases the claim and rethrows. The call is one turn on tier `fast` with no tools, task kind `LEARNING_TASK_KIND` (`learning`), a $0.02 cap (`LEARNING_CALL_CAP_USD`), the system prompt `LEARNING_SYSTEM` and the repository's known rules as `context`. `cleanRule` drops `@handles` and the thread's usernames from the answer and caps its length. A rule whose key matches a candidate of the repository adds the reply to that candidate's sources (`merged`, status kept); otherwise a `proposed` candidate is stored.
- **Direct proposals** (`proposeRule(store, { repo, rule, section, suggestedScope?, reason, by, at })`): a rule proposed without a review reply, e.g. by the MCP tool `propose_rule_change`. No LLM and no cost (`model: 'none'`): `cleanRule` and the key check run, a rule the repository already has a candidate for returns `exists` with that candidate, otherwise a `proposed` candidate is stored with no sources. Nothing reaches prompts until a person accepts it.
- **Decisions**: `acceptLearning(store, candidate, { scope, rule?, section?, by, at })` writes a `GuideLearning` with the candidate's id and source links into the scope's section (creating an empty section, no revision) and marks the candidate accepted; accepting again moves it. `editLearning` changes rule, section or suggested scope, and an accepted candidate's Guide entry follows. `rejectLearning` marks it rejected and takes an accepted rule out of the Guide. An edit that would duplicate another candidate's key throws `LearningConflictError`.
- **Reactions**: 👍/👎 on review comments are counted per finding category (`ReactionSignal`, `LearningStore.reactionTotals`) without an LLM; the server reads them when a merge request closes.

Accepted learnings sit in the resolver after team rules and before policies and generated text.

## Not here yet

The generator lives in [@holtkeeper/guide-generator](../../guide-generator/docs/README.md); the MCP tools `repo_rules` and `propose_rule_change` live in the server's `rules` toolset and use `createGuideResolver` and `proposeRule`.
