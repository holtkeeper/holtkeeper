# Library docs for agents — design

How to set it up and use it: [libraries.md](libraries.md).

Status: implemented in [@holtkeeper/libraries](../packages/libraries/docs/README.md), wired into the server as described in [Libraries](../apps/server/docs/README.md#libraries). The rest of this page is the design; deviations are listed under [Implementation notes](#implementation-notes).

Agents working in a repository should answer "how do I use X", "what changed between the version we have and the next one" and "has anyone hit this error" from version-exact sources served by Holtkeeper's MCP endpoint, instead of searching the web or relying on training data. This covers every third-party library the fleet depends on, not only the packages we publish ourselves.

## Goals

- **Version-exact.** Every answer names the version it comes from, and by default that is the version the asking repository uses.
- **The versions that matter.** Every version in use, plus the versions an upgrade would land on (latest patch, minor and major), not every release ever published.
- **Fleet-aware.** Rank and filter by what the fleet actually imports (`usages`), and tell an agent what an upgrade breaks in our code, not in general.
- **Answers, not pages.** Small, budgeted results like the rest of `/mcp` and `@holtkeeper/agent-tools`.
- **Self-hosted first.** External services are optional fallbacks behind settings, off by default, like Context7 today.

Non-goals: a general web search engine; documentation of languages and platforms themselves (Node, Go standard library) beyond what their packages ship; ecosystems without a lockfile reader in `depgraph-*` (npm and Go come first).

## What already exists

| Piece                                     | Gives us                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@holtkeeper/usages`, `@holtkeeper/fleet` | Which external packages each repository uses, at which resolved versions, and which exports, members and props |
| `@holtkeeper/api-surface`                 | API extraction from published `.d.ts` files, diffs between versions, Markdown for agents                       |
| `/mcp` (`apps/server/src/api-surface`)    | Tokens, access checks, usage counting, `upgrade_impact` over the usage index — today for our own packages only |
| `docs.package` in `agent-tools`           | Changelog `from..to`, migration sections, readme and `.d.ts` outline parsing — today only from `node_modules`  |
| `@holtkeeper/changelog`                   | `parsePackageTag` for monorepo tags (`name@1.2.3`, `path/v1.2.3`)                                              |
| `createHttpRegistry` (`fleet`), `stack`   | Registry lookups for latest versions                                                                           |
| `Store.knowledge`                         | Full-text search (`tsvector` in Postgres, FTS5 in SQLite) and a place for curated quirks                       |
| `@holtkeeper/artifacts`                   | Content-addressed blobs on the filesystem or S3                                                                |
| `docker/egress-proxy`                     | Credentials for private registries and a download cache for immutable archives                                 |
| `context7Server`                          | An external fallback already wired as an optional MCP server                                                   |

The new work is mostly a fetcher and an index around these.

## Version matrix

For each library `(ecosystem, name)` the index keeps a small set of versions, recomputed whenever a `usages` or `fleet` record changes:

1. every version some repository resolves to (`used`);
2. for each used `major.minor`, its newest patch (`patch`);
3. for each used major, its newest minor (`minor`);
4. the newest stable release (`latest`), and the newest release of every major between the highest used major and `latest` (`major`), so a 18 → 20 migration also sees 19;
5. optionally the first release of each of those majors (`x.0.0`), where migration guides and breaking-change notes usually live.

Prereleases count only when used. Versions marked deprecated in the registry keep that flag and the message. Go majors are separate module paths (`/v2`, `/v3`) and are joined into one library.

Example: the fleet resolves `react` to `18.2.0`, `18.3.1` and `19.0.0`, and the newest release is `19.2.1`. The matrix is `18.2.0`, `18.3.1` (used and newest patch of 18.3, newest minor of 18), `19.0.0` (used), the newest 19.0 patch, and `19.2.1` (latest): five versions. Most libraries end up with three to eight.

Libraries the fleet defines itself (`fleet`'s `definedIn`, `depgraph`'s package catalog) are left to `api-surface`, so a public package of the same name never shadows them.

## Sources

Each source is a `LibrarySource` that, given a library and a version, returns documents. They are listed in the order they are fetched and trusted.

| Source                  | What                                                                                                                        | Per version         | Cost                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------- |
| **Registry metadata**   | npm packument / Go `@v/list` + `.info`: versions, dates, deprecations, `repository`, `homepage`, `gitHead`                  | once per library    | one request                  |
| **Package archive**     | npm tarball / Go module zip: `README`, `CHANGELOG`, `MIGRATION`/`UPGRADING`, `docs/**/*.md`, declaration files              | yes                 | one download, cached by S3   |
| **API surface**         | `extractApi` over the unpacked archive (`.d.ts` entries); `go doc` for Go modules                                           | yes                 | local CPU                    |
| **Repository at a tag** | `docs/`, `llms.txt`, `llms-full.txt`, `examples/` at the tag of that version                                                | yes                 | archive download             |
| **Releases**            | GitHub/GitLab release notes per tag; fill gaps where `CHANGELOG` is missing or only links to releases                       | yes                 | paged API                    |
| **Source snapshot**     | Shallow clone of the tag, stored as an archive, for `code.*` tools on demand                                                | on demand           | clone, cached                |
| **Issues, discussions** | See [Issues](#issues)                                                                                                       | by version range    | API quota, optional LLM cost |
| **Docs site**           | `llms.txt` of the homepage first, else `sitemap.xml` and readable-text extraction; only when the repository carries no docs | major only, usually | crawl                        |
| **External fallback**   | Context7, DeepWiki and similar MCP servers mounted for agents next to ours                                                  | their own           | external service             |

Finding the tag of a version: `gitHead` from the npm packument when present (an exact commit), else the first tag that exists among `v<version>`, `<version>`, `<name>@<version>`, `<name>-v<version>` and, for Go, `<subdir>/v<version>`. The repository comes from `repository` in the packument, or the module path for Go. A version without a resolvable tag keeps archive and API sources only.

Every request goes through the egress proxy when one is configured: archives hit its download cache, private registries get their credentials there, and the fetcher never holds a registry token.

## Storage

- **Blobs** in `@holtkeeper/artifacts`: unpacked archive files and source snapshots, keyed by content hash. A README unchanged across ten patch versions is stored once.
- **Library rows**: `(ecosystem, name)` with repository, homepage, matrix and fetch status per source.
- **Version rows**: `(library, version)` with date, tag, commit, deprecation, roles in the matrix (`used`, `patch`, `minor`, `major`, `latest`) and the API surface record id.
- **Chunks**: Markdown split by heading (up to about 1500 characters, with the heading path kept), each with `library`, `versions` (the set of versions that ship the identical chunk), `source`, `path`, `anchor` and a URL. Searched with the same full-text machinery as knowledge entries. Embeddings are a later, optional column (pgvector where the Postgres image has it); full text with version filters is expected to carry most queries, since agents search by API names and error messages.
- **Issue digests**: see below.

This needs new `Store` collections with contract tests, implemented by memory, SQLite and Postgres stores.

Rough size: a few hundred libraries × five versions × tens of kilobytes of Markdown and declarations, minus deduplication, is well under a gigabyte. Source snapshots are the large part and are only made on demand.

## Indexing

A server-side job `library-index`, not a repository analyzer, since it works on the fleet as a whole:

- runs after `usages` or `fleet` records change (debounced) and on a weekly schedule for new releases;
- recomputes every matrix, fetches sources for versions it does not have yet, and drops versions that left every matrix after a grace period (four weeks), keeping blobs other versions share;
- respects per-host request budgets (GitHub REST 5000 requests an hour per token, search 30 a minute) with the existing distributed limiter;
- writes progress and failures per library and source, so the web UI can show what is indexed and why something is missing.

Packages can be excluded or pinned by a scoped setting `libraries` (`exclude`, `include`, `maxVersions`, which sources are on).

## MCP tools

Added to `/mcp` and to the in-process toolset of agents (a `libraries` toolset in `agent-tools`). `version` defaults to what the asking repository resolves, when the client passes `repo` or the agent runs in one; otherwise to `latest`.

| Tool                    | Input                                                      | Output                                                                               |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `library_versions`      | `package`, `repo?`                                         | The matrix with roles, dates, deprecations, and which repositories use which version |
| `get_package_api`       | existing tool, now also for external packages and versions | The API of one version                                                               |
| `diff_versions`         | existing tool, now also for external packages              | Removed, changed, deprecated exports between two versions                            |
| `upgrade_impact`        | existing tool, now also for external packages              | What the diff breaks in the fleet's code, with snippets                              |
| `search_library_docs`   | `package?`, `version?`, `query`, `limit?`                  | Matching chunks, each with library, versions, source and URL                         |
| `read_library_doc`      | `package`, `version`, `path`, `heading?`                   | One document or section                                                              |
| `library_changes`       | `package`, `from`, `to`                                    | Changelog and release notes in `(from, to]`, migration sections for crossed majors   |
| `search_library_issues` | `package`, `query`, `version?`                             | Issue digests, then live search hits; each with state, fix version and link          |
| `library_source`        | `package`, `version`, `path?`                              | A file listing or a file of the source snapshot (made on first request)              |

Results follow the existing budgets: capped, with `… N more` and a hint to narrow. Text from libraries, repositories and issues is third-party content: tool output marks it as such, and nothing in it is treated as an instruction.

## Issues

Issues are the most valuable source for "this error after upgrading" and the noisiest. Two paths:

- **Index** (per library repository, incremental by `updatedAt` like `@holtkeeper/updates`): closed issues and answered discussions created since six months before the oldest used version's release, kept when they have a linked closing pull request, a label such as `bug`, `regression` or `breaking`, or enough reactions; at most a few hundred per repository. Stored with title, labels, first message, accepted answer or maintainer reply, linked pull requests and the release that shipped the fix when it can be found.
- **Live search**: queries the index misses go to the forge's search API scoped to the repository, cached for a day.

Optional **digests**: an LLM turns a matched thread into `{ problem, symptoms (error text), affected versions, fixed in, workaround, links }`, run lazily for threads agents actually hit and charged to `llm.budget` under a task kind of its own. A digest an agent confirms useful can be proposed to `knowledge` as a `quirk` with the package and version range filled in, so curated answers outrank raw threads next time.

Error messages are matched literally (quoted phrases, stack frame names), since that is how agents will search.

## Build or buy

| Need                                          | Decision                         | Why                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version matrix, registry metadata             | Build                            | Small; `fleet` and `stack` already query registries                                                                                                                               |
| API per version, diffs, upgrade impact        | Build                            | `api-surface` and `usages` already do it; no service knows our code                                                                                                               |
| Docs shipped in packages                      | Build                            | Plain files in archives the egress proxy already caches                                                                                                                           |
| Docs in repositories at a tag (gitmcp)        | Build                            | Reading files at a tag; nothing to buy                                                                                                                                            |
| Source at a version (DeepWiki-style)          | Build the snapshot, buy the wiki | Raw source with `code.*` tools is exact and cheap; generated architecture wikis cost many tokens per library and version, so mount DeepWiki's MCP as an optional fallback instead |
| Issues and discussions                        | Build                            | Forge APIs are enough; the work is filtering and ranking, not access                                                                                                              |
| Docs sites that need JavaScript or block bots | Buy, or self-host                | Firecrawl (self-hostable under AGPL) or a similar crawler for the long tail; `llms.txt` and sitemap fetching covers static sites                                                  |
| Curated snippets for popular libraries        | Buy (fallback)                   | Context7, already wired and off by default; queries leave the network                                                                                                             |
| Embeddings                                    | Either                           | An embedding API or a local model; only if full-text search proves insufficient                                                                                                   |
| Stack Overflow                                | Skip                             | API and licence restrictions                                                                                                                                                      |

## Phases

1. **Matrix and API.** Library and version rows, the matrix job, archive fetching, `extractApi` over archives; `library_versions` and the existing API tools working for external npm packages. Done when `upgrade_impact` answers for a third-party package with fleet snippets.
2. **Docs.** Chunks from archives and repositories at tags, releases, full-text search; `search_library_docs`, `read_library_doc`, `library_changes`. `docs.package` reads from the index when the server is reachable and falls back to `node_modules`.
3. **Go.** Module zips, `go doc`, major paths joined.
4. **Source snapshots.** `library_source` and `code.*` tools over a snapshot.
5. **Issues.** Index, live search, optional digests and knowledge proposals.
6. **Fallbacks.** Docs sites via `llms.txt`/sitemap, a crawler setting for the rest, DeepWiki next to Context7 in `externalServers`.

Each phase ships its module docs, store contract tests and a web UI view of what is indexed.

## Open questions

- A GitHub token for the fetcher: a new credential kind, or the forge credential when the fleet itself is on GitHub. Anonymous GitHub access (60 requests an hour) is not enough.
- Private registries other than GitLab's: index them at all, and who may read their docs. Simplest rule: a library's docs are visible to anyone who may read a repository that uses it.
- Package boundaries: one package in a monorepo repository (`@babel/*`) shares the repository's docs and issues; chunks need the package path to avoid answering for a sibling.
- Whether pgvector is available in the CNPG image we deploy, should embeddings become necessary.
- Retention of issue digests when the fix version leaves every matrix.

## Implementation notes

Where the server differs from the design above:

- Indexing runs on an interval (setting `libraries.interval`, default daily, instead of weekly), about two minutes after the server starts, 10 minutes after the last new `usages` or `fleet` record, and on `POST /api/libraries/reindex`.
- The setting is read at global scope only, and nothing is indexed until it is set.
- GitHub tokens are the credentials listed in `libraries.github` (kind `github` in the panel), pooled by the client: each request goes to the token with the most of its limit left. Tokens of one account share GitHub's limit, so duplicates are dropped.
- Tarballs are streamed: npm and GitHub downloads stop at a size limit (50 MB npm, 100 MB repository docs, 200 MB source snapshots) and tar entries that are not kept are skipped without being held in memory.
- Request budgets are the GitHub client's own rate-limit handling, not the distributed limiter: REST `GET`s are conditional (`ETag` in `Store.kv`, so unchanged tags, releases and repository metadata cost nothing), and an index run waits for the hourly reset when every token is exhausted instead of failing its sources.
- Issue digests run through the agent of the caller's repository, so an MCP call without `repo` gets no digests. Knowledge proposals from digests are not wired.
- `upgrade_impact` for third-party packages covers npm only (the usage index reads TypeScript and JavaScript).
