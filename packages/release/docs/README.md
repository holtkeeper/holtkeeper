# @holtkeeper/release

The release assistant: where a repository is in its release flow, what the next version should be, the changelog and a short "what changed" since the previous version, and the steps that act on it — a release candidate merge request, the version (tag, forge release, optional `CHANGELOG.md`) and deploys through the manual jobs of the tag pipeline. Everything is read from and done through `GitForge`; no checkout is needed.

People stay in charge: every suggestion (version, entries, texts, summary, merge request title) can be changed before a step runs, and steps refuse to run while gates fail unless someone overrides them.

## Flow

```
candidate ──propose──▶ proposed ──merge──▶ awaiting-version ──accept──▶ version ──▶ deploy
(source ahead)        (candidate MR open)  (target has changes        (tag, release,   (manual jobs
                                            no version holds)          notes)           per environment)
```

`releaseStage(settings, facts)` gives the most advanced pending stage: `awaiting-version`, `proposed`, `candidate`, `released`, `idle` or `external`. The flow mode decides which apply:

- `merge-request` — a merge request brings `flow.source` (default `development`) into `flow.target` (default: the default branch). The version is created later on the target, once the merged changes are accepted, or right on merge.
- `trunk` — work lands on the target directly; versions are tagged on it. No candidate.
- `external` — another tool (changesets, release-please) releases the repository; versions and deploys are shown, steps are off.

### Acceptance

An abstract "these changes may become a version" signal, so teams tie it to their own process (QA, sign-off, a ticket workflow). `acceptance.signals` lists what counts:

- `manual` — a person in the panel, `holtkeeper release accept`, or `POST /api/releases/accept` (for CI jobs and other systems).
- `label` — `acceptance.label` (default `release-accepted`) on the merged release merge request.
- `merge` — merging the candidate.

An acceptance holds for one head of the target branch; new changes need a new one. With `acceptance.required` the version step refuses without it; with `autoVersion` the version is created as soon as it arrives.

## Settings

The scoped setting `releases` (`releaseSettingsDefinition`, schema `releaseSettingsSchema`, every field defaulted so `{}` is valid). `releaseSettings(value)` parses a stored value. The most specific scope wins, like every setting.

| Field          | What it controls                                                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | Whether the repository shows on the release board                                                                                                                                                                                                                                             |
| `flow`         | `mode`, `source`, `target`                                                                                                                                                                                                                                                                    |
| `version`      | `scheme` (`semver`, `calver`), `tagFormat` (`v{version}`), `calver` format (`YYYY`, `YY`, `0M`, `MM`, `0D`, `DD`, `MICRO`), `initial`, `prerelease` channel, `bump` rules: per commit type, `other`, `breaking`, `initialDevelopment` (breaking while 0.x), merge request `labels`, `minimum` |
| `changelog`    | `merges` (`exclude`, `include`, `only`), `excludeTypes`, `exclude` (regular expressions over subjects), `sections`, `revertPairs`, `groupBy` (`section`, `scope`, `ticket`, `none`), `links`, `authors`, `ticketUrl`                                                                          |
| `summary`      | `mode` (`agent`, `changelog`, `off`), `audience` (`qa`, `users`, `developers`, `managers`), `language`, `instructions`                                                                                                                                                                        |
| `mergeRequest` | `title` (default `Release candidate {date}`), `description`, `labels`, `reviewers`, `draft`, `autoUpdate` (rewrite the description when the source branch moves)                                                                                                                              |
| `acceptance`   | `required`, `signals`, `label`, `autoVersion`                                                                                                                                                                                                                                                 |
| `tag`          | annotated tag `message`, forge `release` with `releaseName` and `notes`, `changelogFile` (`enabled`, `path`, `heading`, commit `message`)                                                                                                                                                     |
| `deploy`       | `environments` (`name`, `job` glob, `after`, `confirm`, `auto`) and `watchMinutes`                                                                                                                                                                                                            |
| `gates`        | `pipeline` (`success`, `not-failed`, `off`), `freeze` windows (`days`, `from`, `to`, `reason`), `blockingLabels`                                                                                                                                                                              |
| `timezone`     | IANA zone for dates in templates and freeze windows                                                                                                                                                                                                                                           |

Templates fill `{date}` (or `{date:DD.MM.YYYY}`), `{version}`, `{tag}`, `{next}`, `{previous}`, `{previousTag}`, `{source}`, `{target}`, `{repo}`, `{summary}`, `{changelog}`, `{compare}` and `{commits}`; unknown placeholders stay as written.

Presets (`releasePresets`) set only their own fields, so they combine: `merge-request-deferred-version`, `merge-request-version-on-merge`, `trunk`, `calver`, `external`, `preprod-prod`, `agent-summary`, `changelog-file`.

`releases.notify` (`releaseNotifyDefinition`, secret) lists Slack or webhook `targets`, each with the `events` it wants (`proposed`, `merged`, `accepted`, `versioned`, `deploy-started`, `deploy-succeeded`, `deploy-failed`; all when empty). `announce(settings, event)` sends through `@holtkeeper/notify` and returns failures instead of throwing.

## Reading

- `collectFacts({ forge, repo, settings, recorded? })` → `ReleaseFacts`: branch heads, version tags (`versionTags`, only tags that follow `tagFormat` and the scheme, newest first), commits on the source not on the target (`ahead`) and on the target since the latest version (`unreleased`), each capped at `commitCap` (300), the open and the last merged candidate, latest pipelines, blocking merge requests and the acceptance (`recorded`, else the label or merge signal). Needs `GitForge.listCommits`; throws `UnsupportedForgeError` without it.
- `boardRow(settings, facts, now, deploy?)` → `ReleaseBoardRow` for the board: stage, latest and next version, counts, tickets, candidate, pipelines, acceptance, since when a version waits, deploy state.
- `detectFlow(input)` / `detectRepositoryFlow(forge, repo)` → `FlowDetection`: a suggested preset and settings from what the repository already does (a `.changeset` folder or package tags → `external`; merged merge requests from `development`/`develop`/`dev` → the merge request flow; else trunk; tag prefix and calendar or semantic versions from the tags), with reasons.

## Planning

`planRelease({ step, facts, settings, edits?, links?, now })` → `ReleasePlan` for `propose` (source commits not on the target) or `version` (target commits since the latest version):

1. **Entries** — `buildEntries(commits, settings.changelog, edits)`: commits grouped by `@holtkeeper/changelog` (same section, type, scope and normalized message → one entry, so repeated messages appear once), trailing `(#12)`/`(!12)` dropped from the text. Rules mark entries `excludedBy: 'rule'`; a commit and its revert in the same range are both `excludedBy: 'revert'`; a person's `edits.excluded`, `edits.included` and `edits.texts` win. Entry ids are stable while the message stays the same, so edits survive new commits.
2. **Version** — `suggestBump(entries, settings.version.bump, { current, labels })` with `reasons` (`minor ← 2 feat`), then `nextVersion(settings, current, bump, versions, now)`: semantic bumps from `version.initial`, calendar versions in the settings' time zone (`MICRO` counts within the period), pre-releases (`1.3.0-rc.2`) with a channel. `edits.version` replaces the suggestion.
3. **Text** — `renderChangelog` (markdown grouped per `groupBy`, links to tickets, merge requests or the commit), the summary (`edits.summary`, else `digestSummary` of the entries, or none), and title and body from the templates. The candidate's body ends with `releaseMarker`, so Holtkeeper recognizes and updates its own merge requests.
4. **Gates** — `checkGates`: the pipeline of the branch the step works on, freeze windows (`activeFreeze`), blocking merge requests, acceptance for `version`; plus `empty` (nothing to release) and `tag-exists` (no, invalid or taken version). `blockingGates(gates, force)`: with `force` only `hardGates` (`empty`, `tag-exists`) still block.

`writeSummary(agent, entries, settings.summary, { version?, previous? })` has the agent write the summary for the audience and language (task kind `release-notes`, no repository access); it rejects on failure so callers keep the digest.

## Steps

All take a `StepContext { forge, repo, settings, now, dryRun? }`, refuse with `GateError` (the failing gates) unless `force`, and report what they would do in a dry run.

- `proposeRelease(context, facts, plan, { force? })` — opens the candidate merge request, or updates the open one's title and description and adds the configured labels.
- `refreshProposal(context, facts, plan)` — rewrites the description of the open candidate when `autoUpdate` is on and the description carries the marker.
- `createVersion(context, facts, plan, { force? })` — with `changelogFile.enabled` commits the notes on top of the file (below a `# ` title, `prependChangelog`) to the target branch; tags the target head (or that commit) with the annotated message; creates a forge release with the notes when `tag.release` is on and the forge can.

## Deploys

`readDeployState(forge, repo, settings, tag)` → `DeployState`: the newest pipeline of the tag and, per configured environment, its status (`no-pipeline`, `missing`, `waiting` — a manual job whose `after` environment has not succeeded —, `ready`, `pending`, `running`, `success`, `failed`, `canceled`, `skipped`), every attempt of its job including retried ones (`listJobRuns` when the forge has it), and what the forge reports deployed there now. `deployState` is the pure part.

`startDeploy({ forge, repo, settings, tag, environment, redeploy?, force? })` plays a manual job, retries a failed or canceled one, reruns a successful one with `redeploy`; refuses (`DeployError` with a `code`) unknown environments, missing pipelines or jobs, jobs already running, and environments whose `after` has not succeeded unless `force`. `autoEnvironments(settings, finished?)` lists environments to start on their own after the version (`finished` absent) or after `finished` succeeded.

## Stored values

`acceptanceSchema`, `releaseEditsSchema` and `releaseEventSchema` validate what callers keep (the server keeps them in `Store.kv`); `readStored(schema, value)` reads a stored value or `undefined`.

## Testing

`@holtkeeper/release/testing` exports `FakeForge`: one repository with a real commit graph (branches, merges, tags, merge requests, pipelines and jobs, releases, files) for flow tests.
