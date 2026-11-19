# @holtkeeper/agent-tools

Token-efficient tools for agents. Instead of `Read` on whole files and `Grep` over everything, the agent gets small, structured answers: an outline before the code, the matching snippet instead of the file, the release notes between two versions instead of the whole changelog. Every result has a hard output budget and says what it left out (`… N more matches`), so one call never floods the context.

The tools are plain `AgentTool`s grouped in `Toolset`s (contract in `@holtkeeper/agent`). The Claude adapter mounts them as an in-process MCP server; any other adapter can call `tool.run(input, ctx)` directly.

```ts
import { claudeAgent } from '@holtkeeper/agent'
import { codeTools, docsTools, knowledgeTools } from '@holtkeeper/agent-tools'

const result = await agent.run({
  dir,
  prompt,
  taskKind: 'review',
  toolsets: [codeTools(), docsTools({ runner })],
})
```

## Contract

- `AgentTool { name; description; input: z.ZodObject; run(input, ctx: { dir, signal, progress? }) → string }` — `run` returns compact text and must stay inside `ctx.dir`; a long call may report what it is doing through `ctx.progress`, present only when someone listens (the MCP endpoint, for clients that sent a progress token). A thrown error is reported to the model as an error result; it does not fail the task.
- `Toolset { name; tools }`. `defineTool({...})` infers `run`'s input type from the schema and returns a `RegistryTool` (see [Registry](#registry)).
- `ToolError`: a failure whose message is meant for the agent as it is (the server's MCP adapter passes it on without a `Failed:` prefix).
- `toMcpServer(toolsets, ctx, name = 'holtkeeper')` → `{ server, allowedTools }`: an SDK `createSdkMcpServer` instance (tools always loaded, not deferred behind tool search) and the qualified tool names. Dots become underscores: `code.search` is `mcp__holtkeeper__code_search`.

## Registry

One set of tool definitions serves the internal agents and the server's MCP endpoint (`apps/server/src/tools`, adapter in `api-surface/mcp.ts`). A `RegistryTool` is an `AgentTool` with optional metadata:

- `readOnly` (default `true`): `false` for tools that write; MCP clients see it as `readOnlyHint`.
- `subject(input)`: what a call is about (a package, a repository), for usage statistics.
- `defaultLimit`: hits returned when `limit` is not passed.
- `narrow`: how to ask the tool for less, e.g. "pass `include` with fewer parts"; a result cut for length ends with it instead of a generic "narrow the request".

A toolset's `instructions` (on `Toolset` of `@holtkeeper/agent`) is a sentence or two on when to use its tools: internal agents get it in their system prompt, and the MCP adapter joins those of `RegistryToolset`s into the server instructions.

- `mountToolsets(available, names)` → the toolsets named in `names`, in that order; unknown names are skipped. Each task mounts only what it needs, because tool schemas cost prompt tokens.
- `RESULT_CAPS = { maxChars: 16000, maxSnippets: 20 }`: about 4k tokens and 20 hits per internal agent call.
- `capText(text, maxChars, hint?)`: the text, or its head cut at a line break followed by `… output cut at about N tokens; <hint>.`
- `capTool(tool, caps = RESULT_CAPS)` / `capToolsets(toolsets, caps)`: a `limit` argument (passed, else `defaultLimit`, else `maxSnippets`) is clamped to `maxSnippets` and the result to `maxChars`, ending with the tool's `narrow` hint when it is cut. The server caps every toolset an internal task mounts; MCP results are cut at 80 000 characters with the same `capText` and hint.

## Budgets

`Budget` (`budgetOf(overrides)`), shared by all tools of a toolset:

| Field            | Default | Meaning                                          |
| ---------------- | ------- | ------------------------------------------------ |
| `maxResultLines` | 200     | Lines per result, truncation marker included     |
| `maxLineLength`  | 200     | Longer lines are clipped with `…`                |
| `maxHits`        | 50      | Matches/definitions per search before `… N more` |
| `snippetLines`   | 5       | Lines shown per structural match                 |

The server uses the defaults; there is no setting for them.

## Tools

### `code` — `codeTools({ budget?, moduleGraph?, files? })`

| Tool           | Input                                                         | Output                                                                                                                                                 |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `code.search`  | `pattern`, `language`, `paths?`                               | `file:line` + snippet (≤ `snippetLines`) per ast-grep match                                                                                            |
| `code.grep`    | `query`, `regex?`, `ignoreCase?`, `context?` (0–3), `paths?`  | `N matches in M files`, then `line: text` / `line- context` grouped by file                                                                            |
| `code.outline` | `path`                                                        | `start-end signature` per import block, function, class (+members), interface, type, enum, variable, export                                            |
| `code.symbol`  | `name`, `references?`, `paths?`                               | `file:start-end signature` per definition; with `references: true`, `line: code` per usage grouped by file, definitions, strings and comments excluded |
| `code.read`    | `path`, `start?`, `end?`                                      | Numbered lines, at most `maxResultLines - 2`, then `continue with start=N`                                                                             |
| `code.imports` | `path`, `direction?` (`importers`, `imports`), `depth?` (1–3) | `importers` (default): files importing the file; `imports`: files and workspace packages it imports; transitively with `depth`                         |

- `files: false` leaves out `code.grep` and `code.read`, for an agent that already has file tools of its own (the server passes it for tasks with the `read` and `search` capabilities, so the agent does not get two of each).
- Languages: the parsers built into `@ast-grep/napi` — `typescript`, `tsx`, `javascript`, `css`, `html` for `code.search`; outline and symbol cover the JavaScript family. No dynamic languages are registered, so this package never conflicts with another package's one-time `registerDynamicLanguage` call.
- Files are walked from the task directory; `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, hidden directories, symlinks and binary files are skipped. Paths are resolved with symlinks and refused outside the checkout.
- Files over 1 MB (`MAX_FILE_BYTES`) are not searched, but never silently: `code.grep` and `code.search` name them in a `not searched: N files over 1.0 MB: <path> (<size>), …` line (first line after the match count, or after `no matches`), pointing lockfiles (`LOCKFILE_NAMES`: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `go.sum`) at `lockfiles.resolve` and tells to read other files in parts. `code.read` reads files up to 32 MB (`MAX_READ_BYTES`) in slices; for one over 1 MB its first line says so (and names `lockfiles.resolve` for a lockfile). It fails with `<path> is missing`, `<path> is binary` or `<path> is <size>, too large to read`.
- `code.imports` uses the module layer of `@holtkeeper/depgraph-js` (files under each workspace's `src/`, type-only imports excluded). It is built on first use and cached for the toolset's lifetime: create one toolset per run. `moduleGraph` replaces the loader.

### `lockfiles` — `lockfileTools()`

`lockfiles.resolve { package, path? }` answers which versions the lockfiles resolve for one package, so agents never grep a lockfile that is too large to search or marked binary in the diff. Every lockfile is parsed in full whatever its size (up to 32 MB) with the parsers of `@holtkeeper/depgraph-js` and `@holtkeeper/go-source`; the answer names each file with its format and size and says `parsed in full`.

- npm packages: every `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` (classic and berry), `pnpm-lock.yaml` and `bun.lock` in the repository (at most 8), or with `path` only the nearest one covering that directory or file. Per lockfile: the resolved versions or `<name> is not present in this lockfile (N packages)` with similar names, and per workspace (at most 15) the range its `package.json` declares, the range the lockfile recorded and the version it resolves, or `the lockfile does not resolve it`.
- Go modules and packages (a name with `/` that is not `@scope/…`): every `go.mod`, or the nearest one covering `path`. The `require` owning the path (with `// indirect` and `replace` targets) and the matching `go.sum` lines with their kind (`module` tree hash, `go.mod` hash), or `not required by go.mod` / `go.sum has no entry for it`.
- No lockfile in reach is a `ToolError` (`no go.mod covers <path>`).

The review mounts this toolset on every pass; its `instructions` tell the agent to use it instead of grepping lockfiles.

### `git` — `gitTools({ runner, budget? })`

Read-only history of the task checkout, so a review can answer "check commit 7d6c…" or explain why code looks the way it does. Every call runs `git --no-pager --literal-pathspecs -c core.quotepath=off -c color.ui=false …` in the task directory through the injected `CommandRunner` (30 s timeout, the task's abort signal); `show` and `diff` add `--no-color --no-ext-diff --no-textconv`. Its `instructions` point the agent at it when someone asks to check a commit, when it needs to know why code looks the way it does and to see what changed since an earlier (e.g. the last reviewed) commit.

| Tool        | Input                                         | Output                                                                                                             |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `git.show`  | `rev`, `path?`                                | `commit <sha>`, author, ISO date, full message, `--stat`, then the patch (of `path` only when given)               |
| `git.log`   | `path?`, `rev?` (`HEAD`), `limit?` (20, ≤ 50) | `<short sha> <date> <author>: <subject>` per commit, newest first; a marker when more commits exist                |
| `git.diff`  | `from`, `to?` (`HEAD`), `path?`               | `diff <from> → <to>`, `--stat`, then the patch between the two revisions                                           |
| `git.blame` | `path`, `start`, `end`, `rev?` (`HEAD`)       | `git blame --date=short` lines (short sha, author, date, line), at most 200 per call, then `continue with start=N` |

- Revisions must be a commit sha or a ref name (`HEAD`, `HEAD~3`, `HEAD^2`, `origin/x`, `refs/tags/v1.0`): no leading `-`, no spaces, no `..` ranges, no `@{…}`. Paths are relative to the checkout, never absolute or with `..`, and always follow `--`. Invalid input is a `ToolError` and git is not run.
- A revision git does not know is a `ToolError` `unknown revision <rev>`, or `commit <rev> is not in this checkout; fetch may be shallow` when `git rev-parse --is-shallow-repository` says the checkout is shallow. Other git failures reach the agent as git's last error lines.
- Patches are cut to the budget (`maxResultLines`, lines clipped to `maxLineLength`, and below `RESULT_CAPS.maxChars`); the header and stat take at most half of it. The last line then says how many patch lines were cut, names the files whose patch was cut and suggests `path`. Merge commits are shown against their first parent.

### `docs` — `docsTools({ budget?, runner? })`

`docs.package { name, ecosystem? ('npm' | 'go'), show?, from?, to?, heading?, workspace? }`

- `summary` (default): installed version (from `node_modules/<name>/package.json`, looked up from `workspace` upwards to the root), description, `types` entry and which docs exist.
- `changelog`: release sections with `from < version <= to` (headings with versions at the dominant level, code fences ignored); the newest three without a range.
- `migration`: `MIGRATION`/`MIGRATING`/`UPGRADING`/`UPGRADE` (also under `docs/`): sections whose heading leads to a major in `(from, to]`; the section list otherwise.
- `readme`: the intro and a section list with line numbers; `heading` returns one section.
- `api`: an outline of the `.d.ts` entry (`types`, `typings` or `exports['.'].types`) and of the files it re-exports from (one level); `heading` filters by name.
- Go (needs a `CommandRunner`): `api` runs `go doc -short <pkg>` or `go doc <pkg> <heading>`; other views locate the module with `go list -m -f {{.Dir}}|{{.Version}}` and read its Markdown files the same way.

### `knowledge` — `knowledgeTools({ access, repo, taskKind, actor, budget? })`

Rules people wrote and rules Holtkeeper learned, for one repository. `KnowledgeAccess` is injected (implemented by the server over its rules and learnings):

- `search(query, { repo, taskKind, limit? })` → `{ id, title, body, score }[]`, `id` in citation form (`rule:<id>`, `learn:<id>`)
- `propose({ text, reason?, files? }, { actor, repo, taskKind })` → `{ id, status, duplicateOf? }`

`search_knowledge { query, limit? (default 5) }` (`SEARCH_KNOWLEDGE_TOOL`) prints `[rule:<id>] title (score)` or `[learn:<id>] …` with each body trimmed to its share of the budget. `propose_learning { text, reason?, files? }` (`PROPOSE_LEARNING_TOOL`) returns `proposed [learn:<id>] (<status>)` or the learning it repeats. The MCP endpoint serves tools of the same names.

Third-party library docs have no toolset here: the server's `packages` toolset (`apps/server/src/tools/packages.ts`) serves them together with the organization's own packages, to internal tasks and MCP clients alike.

## Why this saves tokens

- **Structure first.** `code.outline` costs one line per declaration; the agent then reads a 20-line range with `code.read` instead of a 600-line file.
- **Matches, not files.** `code.search` and `code.symbol` (definitions or, with `references`, usages) return locations with a few lines of context, so locating code does not mean reading it.
- **Exact versions.** `docs.package` answers from what is installed and only for the version step that matters, instead of the agent opening `node_modules` or relying on stale training data.
- **Graph lookups.** Blast radius comes from the prebuilt import graph instead of repeated greps.
- **Bounded output.** Every result is capped and marks truncation, so a broad query costs at most `maxResultLines` and tells the agent to narrow it.
- **Stable prompts.** The Claude adapter keeps the system prompt independent of the run (see `@holtkeeper/agent`), so the tool list and context block are cached across runs.

## Limitations

- Symbol tools are syntactic: same-named identifiers in different scopes are not told apart, and re-exports under another name are not followed.
- The module graph covers files under workspaces' `src/` only.
- The migration view relies on version numbers in headings; guides without them return the section list.
