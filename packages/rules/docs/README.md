# @holtkeeper/rules

The rules every agent run follows on a repository, and the rules Holtkeeper learns. It follows the shape the AI review and coding-agent tools settled on: people write Markdown rules, scoped by paths; learned rules are kept apart, labelled, ranked below the written ones, and expire when nothing confirms them.

## Sources

- **Repository rules files** (`readRepoRules`, `parseRuleFile`, `ruleFilePaths`), read-only:
  - root `REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md` (`ROOT_RULE_FILES`, in that order): always apply;
  - a nested `AGENTS.md` or `CLAUDE.md`: applies to files under its folder;
  - `.github/instructions/**/*.instructions.md`: `applyTo` globs, `excludeAgent` (`code-review` keeps it out of reviews, `coding-agent` out of tasks);
  - `.cursor/rules/**/*.mdc`, `.continue/rules/*.md`: `alwaysApply`, `globs`, `description`;
  - `.claude/rules/*.md`: `paths`, otherwise always;
  - `.windsurf/rules/*.md`: `trigger` (`always_on`, `glob`, `model_decision`; `manual` is skipped).

  Files under `node_modules`, `vendor`, `dist`, `build` are ignored; at most `MAX_RULE_FILES` are read. A file with only a `description` is offered to agents (`requested`) instead of injected.

- **Rules** (`Rule` in [@holtkeeper/store](../../store/docs/README.md)): written in the panel for every repository, teams (a team is its set of repositories) or repository patterns. `files` globs make a rule apply only when the task touches a matching file, `agents` limits it to reviews, tasks, chat or release notes, and a rule with only a `description` is offered instead of injected (`ruleActivation`).
- **Learnings** (`Learning`): one-sentence rules learned from replies to review comments, mined from merged merge requests, proposed by agents, or written by a person.
- **Policies** (`policiesFor`): settings rendered as plain facts — no tests by design, test ids and the asset policy (reviews and tasks), commit conventions (release notes, tasks, chat).

## Learning lifecycle

`newLearning` makes a learning `pending` for `approvalDelayDays` (default 3), after which `settleLearning` makes it `active`; a person may approve or reject it earlier (`decideLearning`). A delay of 0, or a learning a person wrote, is active at once. An active learning not reinforced for `expiryDays` (default 90) becomes `expired`. `reinforceLearning` counts a citation as a use; a new source, a citation whose finding was fixed or an up vote reinforce it and bring an expired one back. `findDuplicateLearning` matches the same normalized text (`learningKey`) or a word overlap of at least 0.8, rejected learnings included, so callers merge instead of adding. `byLearningRank` orders by `learningScore` (fixed citations, uses, votes, sources), then recency.

## Resolver

`resolveRules(input)` is pure and deterministic. Blocks, strongest first:

1. panel rules that always apply, broadest scope first (all, teams, repository patterns);
2. root repository rules files;
3. file-scoped panel rules, then nested and file-scoped repository files, that match the touched `files` (without `files`, all of them, each titled with the paths it applies to);
4. policies;
5. active learnings that apply, under `LEARNED_HEADER`, best ranked first.

The text starts with `RULES_HEADER`; agents cite `[rule:<id>]` and `[learn:<id>]`. `DEFAULT_RULE_BUDGET`: 12 000 characters in all, rules files at most 4 800 together (cut at a line break with `[… truncated, see <file>]`), learnings at most 3 000 and dropped whole. A block with less than 200 characters of room is left out. Every cut adds a warning. The result lists every block with `chars`, `fullChars` and `cut` (the effective-prompt view), and the `requested` rules.
