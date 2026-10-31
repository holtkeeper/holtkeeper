# Library docs for agents

Holtkeeper can index the third-party libraries your repositories depend on and serve their version-exact documentation, release notes, public API, source and GitHub issues to agents over MCP and to people in the web UI. Agents then answer "how do I use this", "what changes if we upgrade" and "has anyone hit this error" from the versions you actually use instead of searching the web.

This page is the how-to. The design and its trade-offs are in [library-docs.md](library-docs.md); the server side in [apps/server/docs](../apps/server/docs/README.md#libraries); the indexer in [@holtkeeper/libraries](../packages/libraries/docs/README.md).

## What gets indexed

For every npm package and Go module your repositories use, Holtkeeper keeps a small set of versions:

- every version some repository resolves to;
- the newest patch of each used minor and the newest minor of each used major (what a safe upgrade lands on);
- the newest stable release, the newest release of every major between yours and it, and the first release of those majors (where migration guides live).

That is usually three to eight versions per library, at most `maxVersions` (8). For each version it reads:

| Source       | What                                                                                      | Needs               |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------- |
| `archive`    | README, CHANGELOG, migration guides and other Markdown shipped in the package             | registry access     |
| `api`        | Exported names with declarations and doc comments (`.d.ts` for npm, Go source for Go)     | registry access     |
| `repository` | `docs/`, `llms.txt`, examples, changelogs from the GitHub repository at the version's tag | GitHub              |
| `releases`   | GitHub release notes                                                                      | GitHub              |
| `issues`     | Closed bug issues with their fix, answered discussions                                    | GitHub (token)      |
| `source`     | A snapshot of the source at the tag, made the first time an agent asks for it             | GitHub              |
| `site`       | The docs site (`llms.txt`, sitemap), off by default                                       | access to that site |

Libraries your own repositories publish are left out: their API already comes from the `api-surface` analysis.

## Before you start

- **A store and an artifact store.** Every store (SQLite, Postgres) supports the index; the artifact store is `.holtkeeper/artifacts` by default or S3 (`server.artifacts`). Nothing else to deploy.
- **Outbound HTTPS from the server process** (the scheduler leader runs the index, not the job workers): `registry.npmjs.org`, `proxy.golang.org`, `api.github.com`, `codeload.github.com`, and, for Go modules on vanity paths such as `golang.org/x/…`, those hosts. Bun honours `HTTPS_PROXY`/`HTTP_PROXY`, so a forward proxy works.
- **Usage records.** The index starts from what repositories use:
  - `usages` records (npm, exact versions): the **Package usage, weekly** schedule runs it on Thursday nights;
  - `fleet` records (npm and Go): the **Quality, licenses and fleet, weekly** schedule runs it on Sunday nights.

  On a fresh install, run them once instead of waiting: **Jobs → Run analyzer → `usages`** for your repositories, and **Fleet → Run now** for each group. Go modules only come from `fleet`.

## Setup

### 1. Add a GitHub token

Without a token GitHub allows 60 requests an hour, which runs out on the first few libraries, and issues lose answers and discussions (they need GraphQL). With a token the limit is 5000 an hour.

1. On GitHub create a token that can read public repositories and nothing else: a fine-grained token with **Public repositories (read-only)** access, or a classic token with no scopes.
2. In Holtkeeper open **Credentials → Add**, kind **github**, give it a name such as `github-libraries`, paste the token as the secret and save.

The token is only used to read public repositories. It never reaches agents or jobs.

**More than one token.** You can add several `github` credentials and list them all in the setting; every request goes to the token with the most of its limit left, and when one runs out the next takes over. GitHub counts the limit per account, not per token: two tokens of the same person (even made for two organizations) share one 5000 an hour, so Holtkeeper checks whose each token is on the first request and drops duplicates with a log line `github: two tokens belong to …`. Capacity only grows with tokens of different accounts, such as a bot account per organization that owns it.

**What a run costs.** Requests are conditional: Holtkeeper keeps each answer's `ETag` and asks again with `If-None-Match`, and GitHub does not count the `304 Not Modified` it answers when nothing changed, so later runs spend requests only on what is new. When every token is used up, the run pauses until GitHub resets the limit (at most an hour), then continues where it stopped; it does not fail its sources. The first run of a few hundred libraries takes roughly 30–40 requests per library.

### 2. Turn the index on

Open **Settings → Libraries → Library docs**, add an entry for **All repositories** (entries for groups or repositories are ignored) and pick the **On** preset, then add the credential from step 1 under **github** (one or more). As a value:

```json
{
  "enabled": true,
  "github": ["github-libraries"]
}
```

Everything else has defaults:

| Field          | Default                                           | Meaning                                                                                          |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `enabled`      | `true`                                            | `false` stops indexing; what is indexed stays readable                                           |
| `interval`     | `1d`                                              | How often to look for new releases and uses, `<n>m`, `<n>h` or `<n>d`, at least `1h`             |
| `github`       | `[]`                                              | Ids or names of GitHub token credentials, shared by every request; a single string also works    |
| `digests`      | `false`                                           | Summarize issue threads agents hit with the configured LLM (see [Issue digests](#issue-digests)) |
| `exclude`      | `["@types/*"]`                                    | Globs of library names never indexed; `Go:` limits a glob to Go, e.g. `Go:github.com/acme/**`    |
| `include`      | `[]`                                              | Globs indexed even when no repository uses them                                                  |
| `maxVersions`  | `8`                                               | Versions kept per library (1–50); the ones in use are always kept                                |
| `firstOfMajor` | `true`                                            | Also index the `x.0.0` release of each crossed major                                             |
| `sources`      | `repository`, `releases`, `issues` on; `site` off | Turn single sources off, or docs sites on                                                        |
| `graceDays`    | `28`                                              | Days a version (or library) stays after nothing needs it any more                                |

### 3. Watch the first run

The server rereads the setting every 30 seconds, so the first run starts within a minute; there is no restart. Later runs come every `interval`, about ten minutes after new `usages` or `fleet` records arrive, and on **Libraries → Reindex now** (needs global `analyses:run`).

The first run downloads every library once and takes a while: minutes for a few dozen libraries, longer for hundreds; later runs only fetch what is new. Follow it on the **Libraries** page (sidebar **Code → Libraries**), which shows the last run with its counts and failures, or in the server log:

```bash
kubectl -n holtkeeper logs deploy/holtkeeper-web | grep libraries:
```

## Using it

### In the web UI

**Code → Libraries** lists the indexed libraries that repositories you can read use, with their versions, how many repositories use them, document sections, issues and sources whose last fetch failed. A library's page shows every version with why it is kept (`used`, `patch`, `minor`, `major`, `first`, `latest`), who uses it, the status of each source, its documents and a search over them.

### From an agent over MCP

1. Open **Public API → MCP for agents** and create a token. It acts as you, read-only, and sees only libraries your repositories use.
2. Add the server to your agent, e.g. Claude Code:

   ```bash
   claude mcp add --transport http holtkeeper https://holtkeeper.example.com/mcp --header "Authorization: Bearer hk_mcp_…"
   ```

3. Ask in terms of your code; the agent picks the tools:

| Tool                                                                  | Use it for                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `library_versions`                                                    | Which versions are indexed, which repositories use which, deprecations                                           |
| `search_library_docs`                                                 | Finding the section about an option, an API or an error, in one library or across all                            |
| `read_library_doc`                                                    | Reading one document or section; without `path`, the list of documents of the version                            |
| `library_changes`                                                     | Changelog, release notes and migration guide sections between two versions                                       |
| `search_library_issues`                                               | Known bugs and their fixes for an error message, indexed first, then a live GitHub search                        |
| `library_source`                                                      | Browsing and reading the library's source at the exact version                                                   |
| `get_package_api`, `list_versions`, `diff_versions`, `upgrade_impact` | The public API of a version, what changed between versions, and which of your call sites an upgrade breaks (npm) |

Every library tool takes an optional `repo` (`forge:path`, e.g. `work:games/app`). With it, the version defaults to the one that repository uses, so "how does `useQuery` handle retries" is answered for your version, not the newest. Without it, the newest indexed version is used. `ecosystem` is `npm` unless you say `Go`.

Examples of prompts that use them well:

- "We are on react-router 6 in work:shop/web. What do we have to change to move to 7?" → `library_changes` and `upgrade_impact`.
- "`TypeError: Cannot read properties of undefined (reading 'getState')` after upgrading zustand, is this a known bug?" → `search_library_issues`.
- "How is retry backoff implemented in github.com/cenkalti/backoff v4?" → `library_source`.

Text coming from libraries, repositories and issues is marked in the answers as third-party content, so agents treat it as data, not instructions.

### From Holtkeeper's own agents

Review, port, propagate and other agent tasks get the same tools as `libraries.versions`, `libraries.search`, `libraries.read`, `libraries.changes`, `libraries.issues` and `libraries.source`, with the task's repository as the default version. Nothing to configure.

## Issue digests

With `"digests": true`, the first time an issue thread comes up in a search it is summarized by the configured LLM into problem, symptoms, affected versions, fixed-in version and workaround, and the summary is stored, so later searches show it directly. At most three threads are summarized per search. Runs are charged to `llm.budget` under task kind `library-digest` and show up in **AI usage**. Over MCP they only happen when the call passes a `repo` you can read, since the repository decides which model and budget apply.

The model is the `library-digest` entry of **Settings → AI → Models per task** (`llm.models`). Every preset there sets it to `claude-haiku@latest`; without an entry Holtkeeper still picks `claude-haiku@latest` when your provider lists it and falls back to **Model** (`llm.model`) otherwise. A summary is a short structured extraction, so a small model does it well; set another entry, e.g. `"library-digest": "claude-sonnet@latest"`, if you want more careful summaries.

## Tuning

- **Too many libraries.** Exclude noise such as `@types/*` (default), test-only tooling or internal mirrors: `"exclude": ["@types/*", "eslint-*", "@storybook/*"]`.
- **A library nobody uses yet** (evaluating a migration target): `"include": ["@tanstack/react-query"]`.
- **Fewer versions.** `"maxVersions": 4` keeps the versions in use plus the most useful upgrade targets.
- **Docs only on a website** (no `docs/` in the repository, nothing in the package): `"sources": { "site": true }`. It reads `llms.txt` or the sitemap, honours `robots.txt` and skips sites that need JavaScript.
- **Faster pick-up of releases**: `"interval": "6h"`.

## Troubleshooting

| Symptom                                                                           | Cause and fix                                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Libraries page says indexing is off                                           | No `libraries` entry for **All repositories**, or `enabled: false`                                                                                   |
| The page is empty after a run                                                     | No `usages` or `fleet` records yet: run those analyses first                                                                                         |
| `libraries: no GitHub token could be read; reading GitHub anonymously` in the log | None of the `github` credentials exists or can be read: check their names or ids. A single missing one is logged as `no credential "…"` and left out |
| Runs take long and the log shows `github: core rate limit exhausted; waiting …`   | Every token is used up; the run waits for the reset and goes on. Add a token of another account to share the load                                    |
| `github: two tokens belong to …` in the log                                       | Both tokens are of one GitHub account and share its limit; one of them is not used                                                                   |
| `api` is `missing` for an npm package                                             | The package ships no `.d.ts`; types published separately as `@types/…` are not used for it                                                           |
| An agent gets "not indexed" for a library you can see                             | The token's owner cannot read any repository that uses it, the library is excluded, or the run has not reached it yet                                |
| `repository`, `releases`, `issues` are `skipped`                                  | The library is not hosted on GitHub; only the package archive and API are indexed                                                                    |
| `repository` is `missing`: "larger than … bytes"                                  | The repository tarball at that tag is over 100 MB compressed, so its docs are not downloaded; the package archive and API still are                  |
