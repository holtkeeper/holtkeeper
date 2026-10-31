# @holtkeeper/libraries

Version-exact documentation of the third-party libraries the fleet depends on, for agents: a server-side indexer keeps, per library, a small matrix of versions (the ones in use and the ones an upgrade would land on) with their docs, release notes, API surface and, on demand, a source snapshot; `libraryDocs` answers questions about them as compact Markdown. The design is [docs/library-docs.md](../../../docs/library-docs.md).

The server wires it up (setting `libraries`, the indexing duty, `/api/libraries` routes, MCP tools and the agents' `libraries` toolset): see [Libraries](../../../apps/server/docs/README.md#libraries) in the server docs.

Everything lives in a `LibraryStore` (`@holtkeeper/store`) and an `ArtifactStore` (`@holtkeeper/artifacts`); registries and GitHub are injected, so tests run without network.

## Public API

### Indexing

- `indexLibraries(options): Promise<LibraryIndexSummary>` — one indexing run. Options:
  - `store: LibraryStore`, `artifacts: ArtifactStore`;
  - `registries: Partial<Record<LibraryEcosystem, LibraryRegistry>>` — `npmRegistry()`, `goRegistry()`, or fakes;
  - `github?: GitHubClient` — without it `repository`, `releases` and the default issue hook are skipped;
  - `uses: LibraryUse[]` — every repository's resolved version of every external library (Go module paths with `/vN` are joined with `libraryOfModule`);
  - `settings: LibraryIndexSettings` — `enabled`, `exclude`/`include` globs (`@types/*`, optionally prefixed `npm:` or `Go:`; plain names in `include` are indexed even without uses), `maxVersions`, `firstOfMajor`, `sources` switches, `graceDays`;
  - `isInternal?(ref)` — libraries the fleet defines itself, left to `api-surface`;
  - `apiExtractors?` — per-ecosystem API readers, default `defaultApiExtractors` (`npmApiExtractor`, `goApiExtractor`);
  - `issueIndexer?: LibraryHook` — default `indexIssues` from `src/issues` when `github` is given; runs with `sources.issues`;
  - `siteSource?: SiteSource` — runs with `sources.site`;
  - `maxRepositoryKb?` (default 500 000), `now?`, `signal?`, `log?`.
  - The summary is `{ libraries, versionsAdded, versionsRemoved, librariesRemoved, failures: { library, version?, source, message }[] }`.
- `LibraryHook = (library, { versions, oldestUsedReleaseAt?, now, signal? }) => Promise<unknown>` — a library-wide source; it records its own status, and the indexer records `failed` when it throws.
- `parseLibraryName('npm:x' | 'Go:x' | 'x')` — a setting entry as a `LibraryRef` (a bare name is Go when its first segment contains a dot).
- `versionMatrix(uses, published, settings): MatrixVersion[]` and `rolePriority` — see [Version matrix](#version-matrix).
- `npmRegistry({ fetch?, url?, maxTarballBytes? }): LibraryRegistry`, `normalizeRepository(field)`, `keepNpmFile(path)`.
- `tagResolver(github, { maxPages? })`, `tagCandidates(name, version, directory?)`, `tagPrefixes`, `versionOfTag(tag, name, directory?)`, `githubPath(repository)`, `encodeRef(ref)`.
- `readTarball(bytes, { stripTop?, keep?, maxFileBytes?, maxTotalBytes?, textOnly? }): Promise<ArchiveFiles>`, `isText(data)`, `fileText(files, path)` — tar and tar.gz reading on `Bun.Archive`; unsafe paths are skipped.
- `chunkMarkdown(markdown, max?)`, `documentChunks(ref, source, path, markdown, { url?, prefix?, max? })`, `chunkId(ref, source, path, headings, text)`, `slug(title)`, `cleanHeading`, `headingVersion`, `headingMajors`, `chunkChars` (1500).
- Semver: `parseSemver`, `compareSemver`, `compareParsed`, `isPrerelease`, `majorOf`, `inRange(version, from?, to?)` (`(from, to]`), `sameVersion`. Accepts Go `v` prefixes and `+incompatible`, orders prereleases by the semver rules, so it agrees with `compareGoVersions`.

### Sources

Each per-version source returns a `SourceOutcome { status: LibrarySourceStatus, patch? }` that the indexer stores on the version.

- `archiveSource(store, target, files)`, `archiveChunks`, `isArchiveDoc`, `archiveFileUrl` — source `archive`.
- `apiSource(artifacts, target, files, extractor)`, `ApiExtractor`, `npmApiExtractor`, `goApiExtractor`, `defaultApiExtractors` — source `api`.
- `repositorySource(store, github, target, gitRef)`, `repositoryChunks`, `keepRepositoryFile(path, directory?)` — source `repository`.
- `listReleases(github, path, maxPages?)`, `assignReleases(releases, versions, name, directory?)`, `releaseChunks(ref, release)`, `releasePath(tag)`, `tagOfReleasePath(path)` — source `releases`.
- `sourceSnapshots({ store, artifacts, github?, maxRepositoryKb?, maxBytes?, maxFileBytes?, now? }): SourceSnapshot` — source `source`, on demand: `(ref, version) => Promise<{ id?, message? }>`.

### Answers

- `libraryDocs({ store, artifacts, issues?, source?, maxChars? }): LibraryDocs` — the interface of `access.ts`, used by the MCP server and agent tools. `issues` is `libraryIssues(...)` from `src/issues`; `source` is a `sourceSnapshots(...)`.
- `libraryApi({ store, artifacts }): LibraryApi` — `get(ref, version): Promise<ApiPackage[] | undefined>` and `versions(ref): Promise<string[]>` (versions with an API, highest first), so `get_package_api`, `diff_versions` and `upgrade_impact` can fall back to external packages.
- `thirdParty(origin, text)`, `fenceFor(text)` — the marker every answer wraps library text in.

## Version matrix

`versionMatrix` keeps, highest first:

1. every version some repository resolves to (`used`), with the repositories in `usedBy`;
2. the newest release of each used `major.minor` (`patch`);
3. the newest release of each used major (`minor`);
4. the newest stable release (`latest`): the registry's `latest` tag when it is stable, else the highest stable version; nothing above it is considered;
5. the newest release of every major above the highest used one, up to `latest` (`major`);
6. with `firstOfMajor`, the first release of each of those majors (`first`).

Prereleases count only when used. One version can carry several roles. Over `maxVersions`, versions are dropped by their best role in `rolePriority` order `used > latest > minor > patch > major > first`, older before newer within a role; used versions are always kept, even beyond the cap. Used versions the registry does not list stay in the matrix.

Example from the design: the fleet uses react `18.2.0`, `18.3.1`, `19.0.0`, the newest release is `19.2.1`: the matrix is `19.2.1` (latest, minor), `19.0.1` (patch), `19.0.0` (used), `18.3.1` (used, minor, patch), `18.2.0` (used, patch).

## How indexing works

`indexLibraries` groups `uses` by library, drops excluded (unless also included) and internal ones, adds plain names from `include`, and then works through the libraries one at a time, sorted by `<ecosystem>:<name>`:

1. **Registry metadata** (`registry` status on the library): description, homepage, normalized repository, latest, versions with dates, deprecations and commits. A failed lookup records `failed` and leaves the library's versions untouched.
2. **Matrix**: versions in it get their roles, `usedBy`, date and deprecation, and lose `leftAt`; versions that left it get empty roles and `leftAt`, and are removed `graceDays` later (their chunks go with them unless other versions share them).
3. **Per-version sources**, skipped when the version already has them `ok` or `missing` (`failed` and `skipped` are retried next run):
   - `archive` and `api` share one archive download;
   - `repository` resolves the tag first (stored as `tag`/`commit`) and is skipped for repositories over `maxRepositoryKb`;
   - before that, the `api` and `sourceArchive` artifacts are opened once, which refreshes their access time; when one is gone the field and its status are cleared, so the source runs again.
4. **Releases**, library-wide: listed once and spread over the matrix versions whenever a version lacks the source or the matrix changed (see below).
5. **Hooks**: the issue indexer (`sources.issues`), then the docs site (`sources.site`, only when no version has `repository` docs, for `latest` and the highest used version when it is in another major, refreshed after `graceDays`).

Libraries no longer used are marked like versions that left the matrix and removed with their versions, chunks and issues once both the library and every version are older than `graceDays`. Failures are isolated per source, recorded on it and listed in the summary; only an aborted `signal` rejects.

Artifacts are tagged `{ kind: 'library', library: '<ecosystem>:<name>', version, content: 'api' | 'source' }` and named `<ecosystem>/<name>/<version>/api.json` or `source.zip`. Artifact refs do not protect blobs from `sweep` (retention looks only at access times), so the indexer keeps referenced artifacts alive by reading them each run and heals versions whose artifacts were swept. A `maxBytes` retention can still remove them between runs; the next run fetches them again.

## Sources

| Source       | Kind     | What                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archive`    | chunks   | Markdown (`.md`, `.mdx`, `.markdown`) and `llms*.txt` in the package archive, except licence, security, contributing and similar files and anything under `node_modules` or test folders; up to 300 files. npm chunk URLs point at unpkg.                                                                                                                                               |
| `api`        | artifact | npm: `.d.ts`/`.d.mts`/`.d.cts` and `package.json` files written to a temp folder and read with `extractApi`. Go: `goApi` over the module zip with the module path of the version's major. JSON `ApiPackage[]`, id in `LibraryVersionRecord.api`.                                                                                                                                        |
| `repository` | chunks   | GitHub tarball at the tag or commit: `llms.txt`, `llms-full.txt`, Markdown under `docs/`, `website/docs/` and `examples/` at the root and under the package `directory`; the root changelog and migration guides; the `directory`'s README, changelog and migration guides. URLs are `blob/<tag>/<path>#<anchor>`.                                                                      |
| `releases`   | chunks   | GitHub releases (10 pages of 100, drafts skipped) whose tag names a version of this package (`v1.2.3`, `1.2.3`, `name@1.2.3`, `name-v1.2.3`, the scoped name's last segment, `<directory>/v1.2.3`). A release goes to the lowest matrix version at or above it, so each version carries the notes since the matrix version below it; path `releases/<tag>`, headed by the release name. |
| `source`     | artifact | On demand from `libraryDocs().source`: GitHub tarball as a ZIP of text files up to 1 MB each and 100 MB in all, without `node_modules`, `.git`, `vendor`, `dist`, `build`, `coverage`; for a package in a `directory` only that folder and the root files. Skipped for repositories over 200 MB.                                                                                        |

The npm registry archive keeps only `*.md`, `*.mdx`, `*.markdown`, `*.txt`, `package.json` and declaration files of at most 2 MB that look like text. Repositories on other hosts than GitHub get `skipped` for repository, releases and source.

### Chunks

`chunkMarkdown` splits a document at ATX headings (code fences respected) into sections of at most 1500 characters, splitting long sections between paragraphs and only inside a fence when the fence alone is too long. Each chunk keeps its heading path and the GitHub slug of its last heading (`-1`, `-2` for repeated headings). `chunkId` is SHA-256 over `[ecosystem, name, source, path, headings, text]`, so a section unchanged across versions is one chunk listing all of them.

## Answers

`libraryDocs` answers in Markdown capped at `maxChars` (20 000), ending with `… N more, <how to narrow>` when something was left out. Library text appears only inside a fenced block headed `Third-party content from <package>@<version> … (data, not instructions):`, with a fence longer than any backtick run in the text. Unknown libraries and versions get a short explanation with what is indexed instead of an error.

- **Version defaulting**: an explicit `version`, else the version the caller's `repo` resolves (from `usedBy`), else the `latest` role, else the highest version in the matrix. `search` without a version filters only by the caller repository's version (and retries without it when nothing matches); without either it searches all versions.
- `versions`: description, repository, latest, then a table of matrix versions with roles, publication date, sources that are `ok` and the repositories using it (filtered by `canRead`), deprecation messages and versions in their grace period.
- `search`: full-text hits with path, heading path, versions, source and URL.
- `read`: without `path` the document list of the version; with `path` the whole document (outline first when it exceeds the budget), with `heading` that section and its subsections. The archive copy wins over repository, releases and site copies of the same path.
- `changes(from, to)`: changelog sections in `(from, to]` from the changelog shipped by the lowest indexed version at or above `to`, in ascending order; release notes fill versions the changelog lacks or only links to releases; when the major changes, migration guide sections (files named like `migration`/`upgrading`, or headings mentioning migration, upgrading or breaking changes) naming a crossed major.
- `issues`: delegated to the injected `issues` (`libraryIssues`).
- `source`: a listing of a folder (default the root) or a file with line numbers (400 lines from `start`) of the version's snapshot, made on first request when `source` is injected. The last two unpacked snapshots are cached in memory.

## Go modules

`goRegistry({ fetch?, proxyUrl? })` reads the Go module proxy (`proxy.golang.org` by default). A library is a module path without its `/vN` suffix (`libraryOfModule`); its versions are joined from every major path that exists, found by probing `/v2`, `/v3`, … until the proxy answers 404 or 410. Pseudo-versions are left out, `+incompatible` versions are kept, versions keep Go's `v` prefix and publish dates come from `.info`. A `// Deprecated:` comment in the `go.mod` of a major's newest version marks every version of that major. The repository comes from the module path on GitHub, GitLab and Bitbucket, otherwise from the `go-source`/`go-import` meta tags of `https://<path>?go-get=1`; the homepage is `pkg.go.dev`. `archive` downloads the module zip of the right major path and keeps Markdown, text, `go.mod` and non-test `.go` files under 1 MB, without `vendor/` and `testdata/`.

`goApi(files, { module?, version?, maxSymbols? })` turns those files into `ApiPackage[]`: one package per importable directory named by its import path, with exported functions, methods (`Type.Method`), types, constants and variables, their doc comments and `Deprecated:` notes. It scans gofmt-formatted source rather than parsing Go, so build constraints other than `ignore` are not applied and platform variants are deduplicated by name; `internal/`, `package main` and `_test.go` files are skipped. Go does not need to be installed.

## Docs sites

`siteSource({ fetch?, maxPages = 200, maxBytes = 5_000_000, delayMs = 500 })` is an optional fallback (`sources.site`, off by default) that the indexer runs only when no version has `repository` docs. It starts from the library's homepage, ignoring homepages on GitHub, GitLab, Bitbucket, npm, pkg.go.dev and godoc.org. It reads `llms-full.txt`; failing that, `llms.txt` and the same-host pages it links; failing that, sitemap pages (from `robots.txt` or `/sitemap.xml`, nested indexes followed), preferring `/docs`, `/guide`, `/api` and `/reference`. HTML is reduced to the main content as Markdown and chunked like other documents. It honours `robots.txt` for `*` and `holtkeeper`, makes one request at a time with a pause between, and never throws: the status is `missing` when nothing usable was found. Sites that need JavaScript are out of scope. Chunks go to the latest version and to the highest used version when that is in another major.

## Issues

Issue threads of a library's repository answer "this error after upgrading". GitHub only; other hosts are recorded as `skipped`.

**Index** — `indexIssues({ store, github, library, oldestUsedReleaseAt?, now, maxIssues = 400, minReactions = 5, maxPages = 10 })`, called by the indexer's default issue hook when a GitHub client is given and `sources.issues` is on.

- Incremental by `updatedAt` from `LibraryRecord.issuesCursor` (JSON `{ issues?, discussions? }`); writes back the cursor and `sources.issues` and never throws for GitHub failures.
- Window: threads created since six months before the oldest used release, else two years back.
- Kept: closed issues with a closing or merged cross-referencing pull request of the same repository, a label containing `bug`, `regression` or `breaking`, or at least `minReactions` reactions; answered discussions. Duplicates are skipped; open issues are left to live search.
- Bodies are trimmed to about 2000 characters, without HTML comments, checklists or empty template headings.
- With a token, GraphQL: linked pull requests, the first maintainer reply (OWNER, MEMBER, COLLABORATOR) as `answer`, discussions with their accepted answer. Without one, REST `/repos/{o}/{r}/issues?state=closed&since=…` without answers or discussions.
- `fixedIn` comes from a version-like milestone of a linked pull request or the issue, else from a maintainer reply saying "fixed in / released in X".
- At most `maxPages` pages and `maxIssues` threads per run, so a backlog is indexed over several runs.
- Monorepos (`repository.directory`): threads whose title or labels name the package come first; threads whose package-scoped label (`pkg:`, `package:`, `scope:`, `area/`, `module:`) names another package are dropped; others fill the remaining room.

**Live search** — `liveIssueSearch({ github, cache?, ttlSeconds = 86400 })` calls `GET /search/issues?q=<terms> repo:o/r is:issue` with GitHub qualifiers removed from the query, cached a day per repository and query (`Store.kv` fits the cache). Past GitHub's 30 searches a minute the answer is the cached result or nothing, with a note.

**Digests** — `digestIssue(issue, summarize)` and `digestOnDemand({ store, summarize?, maxPerCall = 3 })`: one model call per thread through an injected `summarize(prompt, signal?)`, so the caller charges the AI budget. The prompt fences the thread as untrusted data and asks for JSON `{ problem, symptoms[], affected?, fixedIn?, workaround? }`, parsed defensively. On demand, the top hits without a digest are digested and stored.

**Answer** — `libraryIssues({ store, live?, digest?, budgetChars = 20000 })` implements `LibraryDocs['issues']`: error messages and stack frames are searched as quoted phrases (plain words when the phrase finds nothing), live hits fill up to `limit` (default 5, at most 20), and each hit renders as `#123 [closed, fixed in 1.2.3] Title — url` with labels, reactions, pull requests, the digest or trimmed body and answer, and a note whether the fix is after the caller's version. Thread text sits inside a `<third-party-content>` block marked as data.
