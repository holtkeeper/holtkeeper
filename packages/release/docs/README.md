# @holtkeeper/release

The release assistant: where a repository is in its release flow, what the next version should be, the changelog and a short "what changed" since the previous version, and the steps that act on it — a release candidate merge request, the version (tag, forge release, optional `CHANGELOG.md`) and deploys through the manual jobs of the tag pipeline. Everything is read from and done through `GitForge`; no checkout is needed.

People stay in charge: every suggestion (version, entries, texts, notes, merge request title) can be changed before a step runs, and steps refuse to run while gates fail unless someone overrides them.

## Flow

```
candidate ──propose──▶ proposed ──merge──▶ awaiting-version ──accept──▶ version ──▶ deploy
(source ahead)        (candidate MR open)  (target has changes        (tag, release,   (manual jobs
                                            no version holds)          notes)           per environment)
```

`releaseStage(settings, facts)` gives the most advanced pending stage: `awaiting-version`, `proposed`, `candidate`, `released`, `idle` or `external`. The flow mode decides which apply:

- `merge-request` — a merge request brings `flow.source` (default `development`) into `flow.target` (default: the default branch). The version is created later on the target, once the merged changes are accepted when the flow asks for it.
- `trunk` — work lands on the target directly; versions are tagged on it. No candidate.
- `external` — another tool (changesets, release-please) releases the repository; versions and deploys are shown, steps are off.

### Acceptance

An abstract "these changes may become a version" signal, so teams tie it to their own process (QA, sign-off, a ticket workflow). `acceptance` says what the version step waits for:

- `none` (default) — nothing; the version can be created at once.
- `manual` — a person in the panel, or `POST /api/releases/accept` (for CI jobs and other systems).
- `label` — `acceptanceLabel` (`release-accepted`) on the merged release merge request.
- `merge` — merging the candidate.

A person can accept in every mode. An acceptance records who gave it (`by`, the principal id or forge username, and `name`) and where (`channel`: `ui`, `api`, `mcp`, `forge` or a chat surface such as `web`). It holds for one head of the target branch; new changes need a new one. The version is never created on its own.

## Settings

The scoped setting `releases` (`releaseSettingsDefinition`, schema `releaseSettingsSchema`, every field defaulted so `{}` is valid). The most specific scope wins, like every setting. `releaseSettings(value)` parses a stored value and never throws: fields that no longer fit the schema (rows written for an older, larger shape) are dropped one by one, then their parents, and unknown fields are ignored.

| Field                                     | What it controls                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `enabled`                                 | Off by default. Only repositories with releases on are listed and read from the forge                        |
| `flow.mode`, `flow.source`, `flow.target` | See [Flow](#flow)                                                                                            |
| `version.scheme`                          | `semver` or `calver` (`calverFormat`, `YYYY.MM.MICRO`, UTC dates; zero-padded months of older tags continue) |
| `version.tagFormat`                       | Tag around the version, default `v{version}`                                                                 |
| `version.prerelease`                      | Release candidates first: `1.3.0-rc.1`, `rc.2`, ... (`prereleaseChannel`)                                    |
| `acceptance`                              | `none`, `manual`, `label`, `merge`; see [Acceptance](#acceptance)                                            |
| `changelogFile`                           | Prepend each version's notes to `CHANGELOG.md` on the target branch                                          |
| `changelog.excludeTypes`                  | Commit types left out of the changelog, e.g. `ci`                                                            |
| `changelog.ticketUrl`                     | Tracker URL with `{id}` for ticket links                                                                     |
| `mergeRequest.labels`                     | Labels of the candidate merge request                                                                        |
| `deploy.environments`                     | `name`, `job` glob, `after`, `confirm`                                                                       |
| `gates.pipeline`, `gates.blockingLabels`  | A failed or canceled pipeline blocks the step (default on); open merge requests with these labels block it   |

Everything else is fixed:

- **Bumps** follow the commit conventions: `bumpFor` of [@holtkeeper/commit-conventions](../../commit-conventions/docs/README.md) per commit (breaking → major, `feat` → minor, anything else → patch), breaking changes bump the minor version while the major version is 0, the first version is `initialVersion` (`0.1.0`).
- **Changelog**: merge commits left out, a commit and its revert in the same range both left out, entries grouped by section with links to tickets, merge requests or the commit.
- **Texts**: the candidate is titled `Release candidate YYYY-MM-DD` and its description is the notes, the changelog and the next version; the tag message is `Release <version>`; the forge release is named after the tag and carries the notes; the changelog file gets `## <version> (YYYY-MM-DD)` and the commit `chore(release): <version>`. The candidate's description is rewritten whenever its source branch moves.
- **Deploys** are followed for `deployWatchMinutes` (12 hours) and always started by a person.
- **Release notes style** (audience, language, tone) is a Guide rule in the `releases` section, not a setting.

`releases.notify` (`releaseNotifyDefinition`, secret) lists webhook `targets` (`url`, which gets each event as a JSON `Notification`), each with the `events` it wants (`proposed`, `merged`, `accepted`, `versioned`, `deploy-started`, `deploy-succeeded`, `deploy-failed`; all when empty). Events carry the `actor` id and, for people, `actorName` and `channel`; `actorLabel(event)` renders them as `Jane Doe (API)` for the `By` field. `announce(settings, event)` sends through `@holtkeeper/notify` and returns failures instead of throwing.

`releases.announce` (`releaseAnnounceDefinition`, schema `releaseAnnounceSchema`, `releaseAnnounceSettings(value)` parses and falls back to the defaults) says where new versions are announced in Slack; see [Announcements](#announcements).

## Reading

- `collectFacts({ forge, repo, settings, recorded? })` → `ReleaseFacts`: branch heads, version tags (`versionTags`, only tags that follow `tagFormat` and the scheme, newest first; the newest 100 tags, doubling up to 3200 while none of them is a version), commits on the source not on the target (`ahead`) and on the target since the latest version (`unreleased`), each capped at `commitCap` (300), the open and the last merged candidate, latest pipelines, blocking merge requests and the acceptance (`recorded`, else the label or merge signal). Needs `GitForge.listCommits`; throws `UnsupportedForgeError` without it.
- `boardRow(settings, facts, now, { deploy?, edits? })` → `ReleaseBoardRow` for the board: stage, latest version, counts, candidate, pipelines, acceptance, since when a version waits, and from the plan of the pending step (`pendingStep(settings, facts)`: `version` while the target has unreleased changes, else `propose` while the source is ahead, with `edits` applied) the next version and bump, `reasons` (the bump's `because`), `tickets` and their count `tasks`, `leftOut` (entries left out) and `blockers` (failing `block` gates as sentences; acceptance is not one of them). `acceptanceRequired` says the flow asks for an acceptance before a version. `environments` has one `EnvironmentSummary` per configured environment (`environmentSummaries(settings, deploy)`): the tag and version running there (what the forge reports deployed, else the latest version once its job succeeded), the status of the latest version's job and when it last moved; `deploy` is the full deploy state when given.
- `releaseLinks(kind, facts, deploy?)` → `ReleaseLink[]` on GitLab or GitHub: `current` links to the candidate, merged and blocking merge requests, the latest tag, the unreleased and candidate diffs and the pipelines (with status), then `pages` of the project (repository, merge requests, branches, tags, releases, pipelines, environments).
- `detectFlow(input)` / `detectRepositoryFlow(forge, repo)` → `FlowDetection`: a suggested `mode` and settings from what the repository already does (a `.changeset` folder or package tags → `external`; merged merge requests from `development`/`develop`/`dev` → the merge request flow into the branch they are merged into most, which becomes `flow.target` when it is not the default branch (repositories whose default branch is the development branch); else trunk; tag prefix and calendar or semantic versions from the tags), with reasons. It also suggests `mergeRequest.labels` (labels on at least half of the release merge requests), `acceptance: 'label'` (when `release-accepted` was used), `changelogFile` (a root `CHANGELOG.md`), `deploy.environments` (deploy jobs of the newest tag's pipeline, else the default branch's, chained by `after`, `confirm` for manual jobs) and `gates.pipeline` (a protected target branch). `signals` carries the evidence: release labels, the changelog file, the Conventional Commits and tracker shares (with tracker keys), deploy jobs and the target branch. `provenance` maps each suggested setting path (`flow.mode`, `version.scheme`, `deploy.environments`, ...) to its source `{ kind, value, where, at? }`; a setting without an entry is a Holtkeeper default. Missing or failing forge reads (`listCommits`, `listPipelineJobs`) count as empty. Detection reads several forge lists, so the server runs it only on demand (`GET /api/releases/detect`) and never for the board.

## Version timeline

Past versions are read from the forge alone, no checkout:

- `collectRangeFacts({ forge, repo, from?, to, cache? })` → `ReleaseRange { commits, capped }`: commits reachable from `to` but not from `from` (`listCommits({ ref, since })`), at most `commitCap`. When both ends are full commit shas (two version tags) the range can never change, so it is kept in `cache` (`RangeCache`, e.g. `Store.kv`) for good under `rangeKey(repo, from, to)` = `release:range:<forge>:<path>:<from>:<to>` and read from there next time.
- `releaseTasks(commits, links?)` → `ReleaseTask[]`: tracker keys (`ABC-123`, by `ticketKeys` of the commit conventions) found in commit subjects and bodies, so squash commits, merge commits (merge request titles and branch names) and plain commits count, each with up to five distinct titles, its commit count and a tracker link from `changelog.ticketUrl`. Ordered by the newest commit naming them. Without a tracker a task is its key plus those titles.
- `withIssues(tasks, issues)` → the tasks with `issue` (an `Issue` of [@holtkeeper/issues](../../issues/docs/README.md): title, status, category, type, page) for each key `issues` has, the issue's page replacing `url`; keys without one stay as they are. The package never calls a tracker itself.
- `rangeChanges({ forge, repo, settings, from?, to, cache?, links?, current? })` → `RangeChanges { commitCount, capped, entries, changelog, tasks, bump }`: everything one range holds (`collectRangeFacts`, then entries, changelog markdown, tasks and the bump against `current`); `versionDetail` describes a version with it.
- `versionTimeline({ forge, repo, settings, versions, complete?, cache?, links?, offset?, limit? })` → `{ versions: ReleaseVersion[], total, nextOffset? }`: one page of versions, newest first, each with `previous`, `commitCount`, `capped`, `tickets` and the `bump` its changes called for. `timelineVersions(settings, versions)` leaves out release candidates unless `version.prerelease` is on. With `complete: false` (the tags came from a capped list) the oldest version only starts the range of the next one and is not listed; `versionDetail` answers `undefined` for it.
- `versionDetail({ ..., tag })` → `ReleaseVersionDetail` (the version plus `entries`, `changelog` markdown, `tasks` and `compareUrl`), or `undefined` for a tag that is not a version. A release candidate is described against the version before it.
- `versionProvenance(history, tag)` → `ReleaseProvenance` from recorded events (newest first): `versioned` (who, where, when, `force`, where the notes came from, whether a person edited the plan and the written notes (`VersionNotes.markdown`), the `CHANGELOG.md` commit, the release page) and `accepted` (who, where, when, `via`, the note, the accepted commit), the acceptance being the newest one recorded after the previous version for the same commit. `undefined` for versions Holtkeeper did not create.

## Planning

`planRelease({ step, facts, settings, edits?, links?, now })` → `ReleasePlan` for `propose` (source commits not on the target) or `version` (target commits since the latest version):

1. **Entries** — `buildEntries(commits, settings.changelog, edits)`: commits grouped as in [Commits](#commits) (same section, type, scope and normalized message → one entry, so repeated messages appear once), trailing `(#12)`/`(!12)` dropped from the text, each with the `bump` its commits call for. `excludeTypes` and WIP commits mark entries `excludedBy: 'rule'`; a commit and its revert in the same range are both `excludedBy: 'revert'`; a person's `edits.excluded`, `edits.included` and `edits.texts` win. Entry ids are stable while the message stays the same, so edits survive new commits.
2. **Version** — `suggestBump(entries, { current })` with `reasons` (`minor ← 2 feat`), then `nextVersion(settings, current, bump, versions, now)`: semantic bumps from `initialVersion`, calendar versions by the UTC date (`MICRO` counts within the month), release candidates (`1.3.0-rc.2`) with `version.prerelease`. `edits.version` replaces the suggestion.
3. **Text** — `renderChangelog(entries, links?)` (markdown with a `###` heading per section), the notes (`edits.summary`, else `digestSummary` of the entries) and the fixed title and body. The candidate's body ends with `releaseMarker`, so Holtkeeper recognizes and updates its own merge requests.
4. **Gates** — `checkGates(step, settings, facts)`: the pipeline of the branch the step works on, blocking merge requests, acceptance for `version`; plus `empty` (nothing to release), `changelog` (some included entries are not conventional commits) and `tag-exists` (no, invalid or taken version). Each `GateResult` has a `severity`: `block` (a failing one refuses the step), `warn` (`changelog`: shown, never refuses) or `info` (a branch without a pipeline). `blockingGates(gates, force)` keeps failing `block` gates, and with `force` only `hardGates` (`empty`, `tag-exists`); `gatesPass(gates)` tells whether none is left.

`writeSummary(agent, entries, { version?, previous? })` has the agent write the notes in one cheap call (task kind `release-notes`, model tier `fast`, no repository access). Audience, language and style come from the team: the server's agent adds the repository's Guide (sections `releases` and `commits`) as context to tasks of this kind. Notes are written only on demand or when a person proposes with notes; announcements of new tags use `writeAnnouncementNotes` (see [Announcements](#announcements)). It rejects on failure so callers keep the digest.

## Commits

The changelog rules, all pure:

- `parseCommit(subject, body)` → `ParsedCommit`. Conventional type (synonyms normalized: `feature` → `feat`, `bugfix` → `fix`; leading ticket keys such as `[ABC-123] feat: ...` are skipped), scope, breaking (`!` or a `BREAKING CHANGE:` footer, kept as `breakingNote`), description without the prefix, leading ticket keys and a trailing `(#12)`, tickets (`ABC-123`, `[ABC-123]`, `#123`; `UTF-8`-like keys are not tickets), merge or pull request numbers (`(#123)`, `!123`, `See merge request group/x!12`, `Merge pull request #12`), merges (title taken from the body, as GitLab and GitHub write it), reverts (`Revert "..."`, `This reverts commit <sha>`), `Co-authored-by` trailers and `WIP`/`fixup!`/`squash!`/`amend!` markers. Never throws: anything unrecognized leaves `type` unset and the subject as the description. `findTickets(text)` lists the ticket references alone.
- `groupCommits(commits)` → `{ sections, merges }`. Sections follow `sectionOrder` (Breaking changes, Features, Fixes, Performance, Refactoring, Reverts, Docs, Tests, Build & CI, Chores, Other; titles in `sectionTitles`), scoped clusters first, then unscoped ones. `sectionOf(commit)` maps types to sections (`ci` → Build & CI, `style`/`deps`/`release` → Chores, unknown → Other); breaking changes always go to Breaking changes. Commits with the same section, type, scope and `normalizeMessage` result (lowercased, without ticket and merge request references, markers, extra spaces and trailing punctuation; any script) collapse into one `CommitCluster` with all commits, tickets, merge requests and authors; merge commits are collapsed apart.
- `forgeLinks({ kind: 'gitlab' | 'github', webUrl, ticketUrl? })` → `ChangelogLinks`: `commit`, `compare`, `mergeRequest`, `tag` and `ticket` URLs (`#12` goes to the forge's issues, other keys to `ticketUrl` with `{id}`, else none).

## Versions and tags

- `compareVersions(a, b)` orders tag names by semantic version precedence, with or without a leading `v` (pre-releases before their release, numeric identifiers numerically); non-versions compare as equal. `isVersion(name)` tells whether a tag name is one.
- Release tools for monorepos tag every package they publish: `@scope/name@1.2.3` and `name@1.2.3` (changesets, lerna), `path/to/module/v1.2.3` (Go modules), `name-v1.2.3` (release-please). `parsePackageTag(tag)` reads them into `{ tag, package, version }`; plain versions such as `v1.2.3` are not package tags (`isPackageTag`).
- `releaseTarget(tag)` is the ref a job for a tag should run on: the commit sha for package tags, so the tags of one commit are one release, and the tag itself otherwise.

## Steps

All take a `StepContext { forge, repo, settings, now, dryRun? }`, refuse with `GateError` (the failing gates) unless `force`, and report what they would do in a dry run.

- `proposeRelease(context, facts, plan, { force? })` — opens the candidate merge request, or updates the open one's title and description and adds the configured labels.
- `refreshProposal(context, facts, plan)` — rewrites the description of the open candidate when the description carries the marker.
- `createVersion(context, facts, plan, { force? })` — with `changelogFile` commits the notes on top of `CHANGELOG.md` (`changelogPath`, below a `# ` title, `prependChangelog`) to the target branch; tags the target head (or that commit) with the annotated message; creates a forge release with the notes when the forge can.

## Deploys

`readDeployState(forge, repo, settings, tag)` → `DeployState`: the newest pipeline of the tag and, per configured environment, its status (`no-pipeline`, `missing`, `waiting` — a manual job whose `after` environment has not succeeded —, `ready`, `pending`, `running`, `success`, `failed`, `canceled`, `skipped`), every attempt of its job including retried ones (`listJobRuns` when the forge has it), and what the forge reports deployed there now. `deployState` is the pure part. `withDeployActors(state, history)` marks the attempts Holtkeeper started (recorded `deploy-started` events of the tag with their `jobId`) with `actor`, `actorName` and `reason`.

`startDeploy({ forge, repo, settings, tag, environment, redeploy?, force? })` plays a manual job, retries a failed or canceled one, reruns a successful one with `redeploy`; refuses (`DeployError` with a `code`) unknown environments, missing pipelines or jobs, jobs already running, and environments whose `after` has not succeeded unless `force`. `deployFinished(status)` tells final statuses.

## Stored values

`acceptanceSchema`, `releaseEditsSchema` and `releaseEventSchema` validate what callers keep (the server keeps them in `Store.kv`); `readStored(schema, value)` reads a stored value or `undefined`. Besides kind, actor, version, tag, environment, url and detail, a `ReleaseEvent` records what the version sheet shows: `accepted` the accepted `sha`, `via` and `note`; `versioned` the target `sha`, `force`, `notes` (`source`, `edited`) and `changelogSha`; `deploy-started` the `jobId` and `reason`. All are optional, so older events still read.

## Announcements

The pure parts of the server's Slack release announcements ([apps/server/docs/slack.md](../../../apps/server/docs/slack.md#release-announcements)):

- `releaseAnnounceSchema` — `{ channels: string[] (Slack channel ids), tags?: string[] (globs over tag names), groupWindowMinutes (10), notes (true), tasks (true), impact (true), language? }`. No channels, no announcements.
- `announcedTag(settings, announce, tag)` → `AnnouncedTag { name, sha, package?, version }` or `undefined` when the setting does not cover the tag. With `tags` a tag must match one of the globs (a tag that names no version keeps its name as the version); without them tags that follow `version.tagFormat` with a valid version under the scheme count, and package tags (`parsePackageTag`) with their package.
- `previousTag(settings, tag, tags)` → the highest lower version of the same package among `tags` (of the repository for plain tags, compared by the scheme), release candidates only when `tag` is one or `version.prerelease` is on; `undefined` for a first release.
- `breakingEntries(entries)` — included entries the commit conventions mark breaking.
- `packageEntries(entries, packageName)` — the entries of a monorepo range that belong to one package, by conventional-commit scope (the short name `widgets` or `@acme/widgets`; comma-separated scopes count each): when some entry is scoped to the package, entries scoped only to something else are left out; unscoped entries stay. Without any entry naming the package every entry is kept.
- `writeAnnouncementNotes(agent, { packages, language? })` → per package `{ name, overview, highlights, breaking: { change, migration? }[] }`, one call for all packages of an announcement (task kind `release-notes`, tier `fast`, no repository access). Each package brings its entries and `apiBreaking` (removed exports and declarations that lost members, from the API diff), so breaking changes and migration hints come from both. Prose is in `language` (English by default), code and technical terms in English; the Guide's `releases` rules reach the agent as for `writeSummary`. Rejects on failure, so callers announce without notes.

## Testing

`@holtkeeper/release/testing` exports `FakeForge`: one repository with a real commit graph (branches, merges, tags, merge requests, pipelines and jobs, releases, files) for flow tests.
