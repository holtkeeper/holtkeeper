# @holtkeeper/commit-conventions

Works out how a repository names commits and branches, so agents and people write messages that fit. Rules come from four sources, strongest first:

1. **`commits.conventions` setting** — what the team configured for a repository, group or everything.
2. **Push rules** of the forge (`GitForge.getPushRules`, GitLab Premium): regular expressions for commit messages and new branch names. The forge rejects pushes that break them.
3. **commitlint config** on the default branch: `.commitlintrc*`, `commitlint.config.*` or the `commitlint` section of `package.json`.
4. **History**: the last commits of the default branch (`listCommits`) and the work branches (`listBranches`).

```ts
import {
  checkCommitMessage,
  commitConventions,
  renderCommitConventions,
} from '@holtkeeper/commit-conventions'

const conventions = await commitConventions({ forge, repo: 'group/app', setting, commits: 100 })
renderCommitConventions(conventions) // Markdown for agents
checkCommitMessage(conventions.commit, 'feat(web): [GTW-1] add the board') // [] when it fits
```

## Public API

- `commitConventions({ forge, repo, label?, setting?, commits? })` → `CommitConventions`. `forge` needs only `getRepository` and `readFile`. Without `listFiles`, `getPushRules`, `listCommits` or `listBranches`, or when one of them fails, that source is skipped. `commits` defaults to 100.
- `CommitConventions` has `commit` and `branch` (`Ruleset`), `notes?`, `history?` (`HistoryStats`: share of Conventional Commits titles and ticket keys, type and scope counts, how many commits and branches were analyzed) and `consulted` (the sources that were found).
- `Ruleset<Rules>` has `rules` (`CommitRules` or `BranchRules`), `sources` (the `RuleSource` of every field), `patterns` (`PatternRule`: regexes the whole message or name must match, or must not match when `negative`) and `examples`.
- `checkCommitMessage(ruleset, message)` and `checkBranchName(ruleset, name)` → `Problem[]`. A problem from a `history` rule is a `warning`. Every other problem is an `error`.
- `renderCommitConventions(conventions)` and `renderProblems([{ what, problems }])` render Markdown for the MCP tools.
- `commitConventionsSetting`, `commitConventionsKey` (`commits.conventions`), `commitConventionsSchema`: the setting for the registry.

## Combining sources

- **Fields.** Each field of `CommitRules` and `BranchRules` comes from the strongest source that sets it. Push rules set no fields: they only add `patterns`.
- **Patterns.** Patterns from the setting (`commit.pattern`, `commit.forbidden`, `branch.pattern`) and from push rules all apply together.
- **Commit template.** Unless the setting gives one, the template is rebuilt from the merged rules, for example `<type>(<scope>): [<TICKET>] <subject>`.
- **Examples.** The setting's examples come first. Then come real titles and branch names, newest first, that pass every rule: up to 8 commit titles and 5 branch names.
- **Turning history off.** With `history: false` in the setting, commits and branches are not read at all.

Patterns are written in the forge's dialect. A leading `(?i)` becomes the JavaScript `i` flag. A pattern JavaScript cannot compile is still shown to agents but is not checked.

## What history establishes

Merges, reverts, `fixup!`/`squash!`/`amend!` commits and WIP commits are left out. A history rule needs at least 10 analyzed commits, or 5 work branches (not the default branch and not protected ones). A style becomes a rule when at least 80% of them follow it:

- **Commit titles.**
  - `conventional`: titles have the form `type(scope)!: subject`.
  - `scopeRequired`: at least 80% of conventional titles have a scope.
  - `ticket`: tracker keys such as `GTW-435`. A key pattern is set once 30% of titles carry one, and it becomes `required` at 80%. Keys of projects seen once are dropped when others repeat. The placement needs 60% agreement, otherwise it is `anywhere`. The placements are `lead` (`[GTW-1] feat: subject`, where the title still counts as conventional), `bracket` (`feat: [GTW-1] subject`), `prefix` (`feat: GTW-1 subject`), `scope` (`feat(GTW-1): subject`) and `suffix` (`feat: subject (GTW-1)`).
  - `maxLength`: 72, or 100 if 72 does not fit, when 95% of titles fit.
  - `subjectCase`: the first letter of the subject, ignoring leading acronyms like `API`.
  - `noTrailingPeriod`: at most 5% of titles end with a period.
  - `body`: `none` when at most 20% of commits have a body, `required` at 80%. Git trailers such as `Co-Authored-By:` do not count as a body.
- **Types and scopes** of commits are reported as counts only. A short history does not show every type that is allowed.
- **Branches.**
  - `prefixes`: names start with a prefix such as `feat/`. Prefixes seen at least twice are kept.
  - `ticket`: names carry a tracker key.
  - `case`: the rest of the name is `kebab` or `snake`.
  - `template`: for example `<prefix>/<TICKET>-<description>`.

## commitlint

The config is read as text, never run. This module recognizes:

- `extends` of `@commitlint/config-conventional`: conventional titles, its eleven types, `maxLength` 100 and no trailing period;
- `type-enum`, `scope-enum`, `scope-empty`, `header-max-length`, `subject-full-stop` and `body-empty` written as literals (`[2, 'always', [...]]`, also YAML flow lists).

Level 0 disables a rule. Rules that are built in code are not seen.
