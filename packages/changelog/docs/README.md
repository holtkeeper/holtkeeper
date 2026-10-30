# @holtkeeper/changelog

Release analysis: what changed between two releases, as a commit history grouped by type and scope, with identical messages collapsed, links into the forge, contributors and referenced tickets. Produces serializable `ChangelogData` and a `changelog` analysis kind that turns it into a universal `Report` (`@holtkeeper/report`).

## Pipeline

Every step is replaceable:

1. **`HistorySource`** — where history comes from. `gitHistory({ runner? })` uses the git CLI through a `CommandRunner` (`localRunner` by default). A forge-API source can implement the same contract.
   - `listRefs(dir)` — tags, newest first: by semantic version when every tag name is a version, by date otherwise. Annotated tags carry their message.
   - `resolve(dir, ref)` — any ref (tag, branch, sha, `HEAD`) to `{ name, sha, date }`.
   - `commits(dir, { from?, to })` — `from..to`, newest first, with author, ISO date, parents, subject, body and per-commit stats.
   - `diffStat?(dir, range)` — optional net change of the range (files counted once).
   - `changedFiles?(dir, range)` — optional per-file diff of the range: path, lines added/removed, status (`added`, `modified`, `deleted`, `renamed`), `previousPath` for renames, `binary` for binary files (zero line counts). git uses `diff -z --numstat -M` joined with `--name-status`.
2. **`parseCommit(subject, body)`** — pure. Conventional type (synonyms normalized: `feature` → `feat`), scope, breaking (`!` or `BREAKING CHANGE:` footer), description without the prefix and leading ticket keys, tickets (`GTW-435`, `[GTW-435]`, `#123`), merge/pull request numbers (`(#123)`, `!123`, `See merge request group/x!12`, `Merge pull request #12`), merges (title taken from the body, as GitLab and GitHub write it), reverts (`Revert "..."`, `This reverts commit <sha>`), `Co-authored-by` trailers, `WIP`/`fixup!`/`squash!` markers.
3. **`groupCommits(commits)`** — pure. Sections in a fixed order (Breaking changes, Features, Fixes, Performance, Refactoring, Reverts, Docs, Tests, Build & CI, Chores, Other), scopes inside. Commits with the same section, type, scope and `normalizeMessage` result collapse into one `CommitCluster` with all commits; merges are collapsed separately. Also contributors (authored and co-authored commits, lines), tickets and merge requests.
4. **`forgeLinks({ kind: 'gitlab' | 'github', webUrl, ticketUrl? })`** — `commit`, `compare`, `mergeRequest`, `tag`, `ticket` URLs plus `templates` (strings with `{sha}`, `{from}`, `{to}`, `{n}`, `{name}`, `{id}`). `linksFromTemplates(templates)` rebuilds the functions from stored data.
5. **`analyzeChangelog({ dir, to, from?, history?, links? })`** — resolves refs (default `from` is the release before `to` on another commit; none for the first release), loads and parses commits, and returns `ChangelogData`. A commit carrying package tags is a monorepo release (see below).
6. **`changelogAnalysis`** — the `changelog` `AnalysisKind`; `changelogDataSchema` (zod) validates uploads.

## Monorepo releases

Release tools for monorepos tag every package they publish: `@scope/name@1.2.3` and `name@1.2.3` (changesets, lerna), `path/to/module/v1.2.3` (Go modules), `name-v1.2.3` (release-please). `parsePackageTag(tag)` reads them; plain versions such as `v1.2.3` are not package tags.

A commit carrying package tags is one release, whichever of its tags `to` names (or its sha): `to.name` is the commit sha and `to.tags` lists every tag on it; `from` is the previous tagged commit, also as one release. `packages` lists what it published with each package's previous version. `releaseTarget(tag)` gives the ref a release job should use: the sha for package tags, the tag otherwise, so jobs for the tags of one commit collapse into one.

## Data

```ts
interface ChangelogData {
  from?: ReleaseRef // { name, sha, date, message?, tags? }
  to: ReleaseRef
  commits: ChangelogCommit[] // CommitInfo + parsed: ParsedCommit, newest first
  diff?: DiffStat // { files, insertions, deletions } between from and to
  files?: ChangedFile[] // most changed first, at most maxChangedFiles (5000)
  filesTruncated?: boolean // set when files were cut
  packages?: PackageRelease[] // { name, version, tag, previous? } for monorepo releases
  links?: LinkTemplates
}
```

Grouping is not stored: reports regroup from `commits`, so improvements to clustering apply to old records too.

## Report

Metrics: commits (merges excluded), contributors, features, fixes and breaking changes (collapsed entries), files changed, lines added/removed, days since the previous release. With a `previous` record each metric carries a delta.

Monorepo releases are titled `Release <tag>` (one package) or `Release of N packages`, add a `Packages released` metric and refer to commits by short sha.

Sections, each present only when it has content:

- **Packages** — monorepo releases: package, version, previous version and bump (`major`, `minor`, `patch`, `prerelease`, `new`).
- **Highlights** — issues block: breaking changes (with the footer note) and reverts.
- **Changelog** — one timeline per section; collapsed clusters show `fix(upload): retry upload ×4` with every commit as `children`; tags for scope, tickets and merge requests; commit links. Merge commits get their own timeline.
- **Activity** — stacked bars of commits per day (per week for ranges over two months) by section.
- **Contributors** — table with commits, co-authored commits, lines added and removed.
- **Most changed files** — the top 20 files by lines changed, with status and renames.
- **Tickets and merge requests** — table with links, grouped by kind.
- **Compare** — markdown link to the forge's compare view and the tag message, or the commit's tags for monorepo releases.

## Usage

```ts
import { analyzeChangelog, changelogAnalysis, forgeLinks } from '@holtkeeper/changelog'

const data = await analyzeChangelog({
  dir: '/path/to/clone',
  to: 'v1.1.0',
  links: forgeLinks({ kind: 'gitlab', webUrl: 'https://gitlab.example.com/games/app' }),
})
const report = changelogAnalysis.toReport({
  id,
  repo,
  kind: 'changelog',
  ref: 'v1.1.0',
  createdAt,
  data,
})
```

Clones must have tags fetched; shallow clones only see the commits they contain.
