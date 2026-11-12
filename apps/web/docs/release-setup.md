# Release flow setup

Part of the web app's [Releases](README.md#releases) docs.

**Flow setup** (`/releases/setup?repo=<forge:path>`, `features/releases/SetupPage.tsx`) is the third tab of the Releases workspace, after Overview (`/releases`) and Timeline (`/releases/timeline`). It edits one repository's `releases` setting. Nothing is tagged or deployed from here.

## What the page shows

- **No `repo`.** A picker of the repositories the caller may configure (`GET /api/repos`, `configurable`); picking one opens its setup.
- **No `settings:write`** (`ReleaseRepoView.can.configure` is false). The effective flow as read-only lines (`FlowSummary`).
- **Not configured yet.** No `releases` entry covers the repository (`GET /api/settings/resolve` → `cascade.releases` is empty), so the page runs as a wizard with three steps (`setupSteps`): **Flow** (mode, branches, release MR labels, acceptance, gates), **Versions** (scheme, tag format, release candidates, `CHANGELOG.md`, left-out commit types, tracker URL) and **Environments** (deploy jobs, order, confirmation, plus the read-only webhooks). The step list, the flow strip and **Back** / **Continue** move between steps. The last step has **Save the flow** and **Turn releases on when I finish** (on by default).
- **Already configured.** Edit mode: no steps. **Releases on**, Flow, Versions and changelog, and Environments sit on one page, with the header's primary **Save** (enabled once the draft differs) and **Start over** in "⋯".

The draft lives only in the page (`useState`) until the single save. That save goes through `PUT /api/settings` (`useSettingMutations().put`). It updates the repository's own entry (`repoReleaseEntry`: the `releases` entry whose scope names exactly this repository) or creates one scoped `{ repos: ['forge:path'] }`, and the Releases queries are invalidated. Before saving, the value is cleaned (`cleanSettings`): branches and names are trimmed, an empty target, tracker URL or deploy job is left out, and an `after` that names no other environment is dropped. `draftErrors` blocks the save: a missing source branch, a target equal to the source, a tag format without `{version}`, and empty or duplicate environment names. The page then jumps to the first step with an error (`firstErrorStep`), and that step shows a "fix" tag. After a wizard save the page opens the repository's timeline.

## Detection

Detection is read from the forge on request and never kept in the snapshot (`useReleaseDetect`, `GET /api/releases/detect`). The wizard reads it as soon as it opens. Edit mode reads it only after **Read the forge** (or "⋯" **Read the forge again**).

- **The suggestion.** A notice names the detected mode and its reasons. While setting up, **Use it and turn releases on** lays the suggestions over the draft, turns releases on and saves in one step (the same checks as Save; a field error opens its step instead), and **Review the suggestions first** only lays them over the draft; once configured the button is **Use the suggestions**. Laying them over (`applyDetection`): each suggested section replaces the fields it names, suggested environments replace the list, a suggested flow drops the current target unless it names one, and values of the wrong shape are ignored.
- **What we read.** Its own panel under Detect with a table (`signalRows`, `SignalTable`) with one row per piece of evidence: release labels, the changelog file, the Conventional Commits and tracker-key shares, deploy jobs, the protected target branch, and the merge requests, tags or files that only back a suggestion. Each row shows its kind, value, where and when it was read, and the settings it suggests, from `FlowDetection.provenance`.
- **Source tags.** Every field and every step of the flow strip carries a source tag (`fieldSource`, `combinedSource`):
  - `detected` while the value equals an evidenced suggestion;
  - `edited` once it differs from what the page started with;
  - otherwise `saved` (configured repository) or `default` (Holtkeeper default).

## Flow strip

`flowStrip` draws the draft from left to right in three groups:

- **Branches:** source, release MR (labels and acceptance) and target with its gate count for merge request mode; only the target for trunk; one external-tool step for external mode.
- **Tags:** an example tag (`exampleTag`). External mode has none.
- **Environments:** each one's job, predecessor and whether it asks first.

In the wizard, a click on a step opens the setup step that edits it.

## Environments

`EnvironmentFields` edits the list in order. **+ Environment** (`addEnvironment`) names `staging`, then `production`, then `environment-N`, and deploys each after the last. Renaming an environment carries over to the environments deployed after it, and removing one drops their `after` (`withEnvironment`).

## Release webhooks

`releases.notify` entries are shown read-only (`NotifyWebhooks`). They are sealed settings, so the page sees only their scope and last change, never their URLs or events. **Manage in Settings** opens Settings › Integrations.

## Links

- The Releases overview, the timeline, the repository hub's Releases tab and the CI sheet's **Release gates** link here with `?repo=`.
- The release notes style is a Guide rule (section Releases), not a field here.
