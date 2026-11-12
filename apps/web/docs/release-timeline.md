# Release timeline

Part of the web app's [Releases](README.md#releases) docs.

`/releases/timeline?repo=` (`ReleaseTimelinePage` in `features/releases/ReleaseTimelinePage.tsx`) shows one repository's releases. The page body is `ReleaseTimelineView`, which the repository hub's **Releases** tab (`features/repo/tabs/RepoReleasesTab.tsx`) embeds with links to this page and to the flow setup. It reads `GET /api/releases/repo` (`useReleaseRepo`, polled every 5 s while a deploy of the latest version runs), the versions from `GET /api/releases/timeline` a page at a time and one version from `GET /api/releases/version`. Timeline-only helpers live in `lib/release-timeline.ts`; plan edits, gates, stage words and actor names shared with other pages in `lib/releases.ts`.

## Header

The workspace tabs come from the shell. The title row holds a repository switch over the repositories on the overview (`GET /api/releases/overview`), a ghost **Configure** to `/releases/setup?repo=` for people with `settings:write` there, and the ⋯ menu with **Read the forge again** (a background read of every repository) and **Open repository**. The search field (`/`) narrows the versions table by tag, version, commit prefix or task key. Without `?repo=` the page opens the first repository of the overview, action first (`actionFirst`); it asks for one only when no repository has releases on.

Above the next release: notices for a dry run, a read-only repository and releases turned off (with **Set up its flow** to the setup page), then the stage tag (`overviewTag`, the same words and tone as the Overview), the flow in a line (`flowSummary`: mode, target branch and an example tag) and the forge links of the current release (merge request, compare, tag, pipeline with its status).

The stage tag reads a pending version as _Waiting for acceptance_ while `row.acceptanceRequired` is true and `row.acceptance` is absent (the target head is not accepted), otherwise _Ready to tag_; a forge error and a failed deploy come first (`overviewState`).

## Next release

`NextCard` shows the pending step: the version when the target branch has unreleased changes, the release MR when the source branch is ahead, with a switch when both wait.

- **Bump row**: current → next version in mono, the bump, **Change version** (semantic patch, minor, major or a custom version), the commit count on the branch and how long the version has waited (`row.waitingSince`), then the reasons for the bump from the commit conventions.
- **Changes** grouped by type with left-out ones counted, **Edit entries** (include, leave out, rename; previewed locally with `previewEdits` before the server answers), **Tasks** with tracker status, and **What changed** (the notes: digest of the changelog, written by AI or edited by a person; **Write with AI**, edit, back to the digest).
- **Gates checklist** (`checklistRows`): every `GateResult` of the plan with a pass or fail mark and its severity in a word: `blocks` (a failing one refuses the step unless overridden in the confirmation, `empty` and `tag-exists` never), `warns`, `info`. A failing acceptance gate says how to accept in this flow. It has exactly one changelog line: the plan's `changelog` gate (ready, or how many entries are not conventional commits), else _Changelog ready_ or _Changelog empty_ worked out on the client, followed by the included entries, left-out ones, where the notes come from and whether they are prepended to `CHANGELOG.md`.
- **Accepted by** the person or forge user with where and when, and **Withdraw** with `releases:run`.
- **Actions**: a line saying what the step does after the confirmation, **Accept {version}** only when `can.accept` is true and the version waits for acceptance (`awaitsAcceptance`), and the step's button (**Create {tag}**, **Open release MR**, **Update !n**) with `releases:run` on a writable repository. The button stays off while a gate nobody may override fails or a version waits for its acceptance (`stepBlockedBy`, the reason in the line beside the buttons). The confirmation lists what will happen, previews the text, offers AI notes for a release MR and asks to override failing `block` gates.

## Environments

`EnvironmentsPanel` (in `DeployStrip.tsx`), only when the repository deploys somewhere: one card per configured environment in order with the latest version's deploy status there (live from `GET /api/releases/deploy`, polled while a job runs, else `row.environments`), the version it runs now (`row.environments[].tag`), the job, its order (`environmentOrder`: right after the tag or after another environment, and whether it asks first) and the newest attempt with its link and duration. With `releases:run` a card offers **Deploy**, **Retry** or **Deploy again** (`deployKind`); environments that ask first, wait for an earlier one, retries and repeats go through a confirmation that takes a reason (kept on the attempt and in the history) and, for a waiting environment, an explicit override.

## Versions

`VersionList`: a table of past versions, newest first, with the bump, changes (`changesText`), one column per environment where the version stands by its newest recorded deploy (`versionEnvironments`, `versionDeployCell`: _Deployed_, _Deploying_, _Failed_, _Not deployed_, each with a dot and the word), the release date and the short commit. **Bump** and **Deployed to** filters and the page search narrow the loaded versions (`filterVersions`). The footer counts loaded versions against the total, loads older ones and hints J/K. A row opens the version sheet; J and K step through the shown rows.

## Version sheet

`VersionSheet` opens a version in the `SideSheet`: the tag (copyable), the repository, a progress bar with one segment per environment (`versionTicks`, `deployProgress`) captioned with the environments that run it now (`liveOn`), and **Compare** with the previous version. Tabs:

1. **Deploys** (`VersionDeploys`): per environment its status, every attempt newest first with its status, start time, who started it through Holtkeeper and why (`attemptLine` over `DeployAttempt.actor` and `reason`) and its duration, and the deploy action as on the panel. Then the version facts (tag on the target branch, bump, previous version and commit count, commit, release date) and **How it was cut** from `ReleaseVersionDetailView.provenance`: who accepted it, where and when, how (`acceptedVia`), their note and the accepted commit; who tagged it, whether failing checks were overridden (`force`), where the notes came from and whether the plan was edited (`versionNotesText`), the `CHANGELOG.md` commit and the release page. A version Holtkeeper did not create says so.
2. **Changelog**: the version's changelog Markdown.
3. **Tasks**: its tracker keys with titles and status.
4. **Notes**: the written notes the version was created with (`provenance.versioned.notes.markdown`) under their source line (`versionNotesText`); versions Holtkeeper did not create, or created without notes, say so.
