# @holtkeeper/agent-tools

Token-efficient tools for agents. Instead of `Read` on whole files and `Grep` over everything, the agent gets small, structured answers: an outline before the code, the matching snippet instead of the file, the release notes between two versions instead of the whole changelog. Every result has a hard output budget and says what it left out (`… N more matches`), so one call never floods the context.

The tools are plain `AgentTool`s grouped in `Toolset`s (contract in `@holtkeeper/agent`). The Claude adapter mounts them as an in-process MCP server; any other adapter can call `tool.run(input, ctx)` directly.

```ts
import { claudeAgent } from '@holtkeeper/agent'
import { codeTools, docsTools, externalServers, knowledgeTools } from '@holtkeeper/agent-tools'

const result = await agent.run({
  dir,
  prompt,
  taskKind: 'review',
  toolsets: [
    codeTools({ budget: { maxResultLines: settings.maxResultLines } }),
    docsTools({ runner }),
  ],
  mcpServers: externalServers(settings), // Context7 only when agent.tools.context7 is true
})
```

## Contract

- `AgentTool { name; description; input: z.ZodObject; run(input, ctx: { dir, signal }) → string }` — `run` returns compact text and must stay inside `ctx.dir`. A thrown error is reported to the model as an error result; it does not fail the task.
- `Toolset { name; tools }`. `defineTool({...})` infers `run`'s input type from the schema.
- `toMcpServer(toolsets, ctx, name = 'holtkeeper')` → `{ server, allowedTools }`: an SDK `createSdkMcpServer` instance (tools always loaded, not deferred behind tool search) and the qualified tool names. Dots become underscores: `code.search` is `mcp__holtkeeper__code_search`.

## Budgets

`Budget` (`budgetOf(overrides)`), shared by all tools of a toolset:

| Field            | Default | Meaning                                          |
| ---------------- | ------- | ------------------------------------------------ |
| `maxResultLines` | 200     | Lines per result, truncation marker included     |
| `maxLineLength`  | 200     | Longer lines are clipped with `…`                |
| `maxHits`        | 50      | Matches/definitions per search before `… N more` |
| `snippetLines`   | 5       | Lines shown per structural match                 |

The `agent.tools.maxResultLines` setting maps to `maxResultLines`.

## Tools

### `code` — `codeTools({ budget?, moduleGraph? })`

| Tool                | Input                                                        | Output                                                                                                      |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `code.search`       | `pattern`, `language`, `paths?`                              | `file:line` + snippet (≤ `snippetLines`) per ast-grep match                                                 |
| `code.grep`         | `query`, `regex?`, `ignoreCase?`, `context?` (0–3), `paths?` | `N matches in M files`, then `line: text` / `line- context` grouped by file                                 |
| `code.outline`      | `path`                                                       | `start-end signature` per import block, function, class (+members), interface, type, enum, variable, export |
| `code.symbol`       | `name`, `paths?`                                             | `file:start-end signature` per definition                                                                   |
| `code.references`   | `name`, `paths?`                                             | `line: code` per usage, grouped by file; definitions, strings and comments excluded                         |
| `code.read`         | `path`, `start?`, `end?`                                     | Numbered lines, at most `maxResultLines - 2`, then `continue with start=N`                                  |
| `code.dependents`   | `path`, `depth?` (1–3)                                       | Files importing the file (transitively with `depth`)                                                        |
| `code.dependencies` | `path`, `depth?` (1–3)                                       | Files and workspace packages the file imports                                                               |

- Languages: the parsers built into `@ast-grep/napi` — `typescript`, `tsx`, `javascript`, `css`, `html` for `code.search`; outline, symbol and references cover the JavaScript family. No dynamic languages are registered, so this package never conflicts with another package's one-time `registerDynamicLanguage` call.
- Files are walked from the task directory; `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor`, hidden directories, symlinks, binary files and files over 1 MB are skipped. Paths are resolved with symlinks and refused outside the checkout.
- `code.dependents`/`code.dependencies` use the module layer of `@holtkeeper/depgraph-js` (files under each workspace's `src/`, type-only imports excluded). It is built on first use and cached for the toolset's lifetime: create one toolset per run. `moduleGraph` replaces the loader.

### `docs` — `docsTools({ budget?, runner? })`

`docs.package { name, ecosystem? ('npm' | 'go'), show?, from?, to?, heading?, workspace? }`

- `summary` (default): installed version (from `node_modules/<name>/package.json`, looked up from `workspace` upwards to the root), description, `types` entry and which docs exist.
- `changelog`: release sections with `from < version <= to` (headings with versions at the dominant level, code fences ignored); the newest three without a range.
- `migration`: `MIGRATION`/`MIGRATING`/`UPGRADING`/`UPGRADE` (also under `docs/`): sections whose heading leads to a major in `(from, to]`; the section list otherwise.
- `readme`: the intro and a section list with line numbers; `heading` returns one section.
- `api`: an outline of the `.d.ts` entry (`types`, `typings` or `exports['.'].types`) and of the files it re-exports from (one level); `heading` filters by name.
- Go (needs a `CommandRunner`): `api` runs `go doc -short <pkg>` or `go doc <pkg> <heading>`; other views locate the module with `go list -m -f {{.Dir}}|{{.Version}}` and read its Markdown files the same way.

### `knowledge` — `knowledgeTools({ access, repo, taskKind, actor, packages?, budget? })`

`KnowledgeAccess` is injected (implemented elsewhere):

- `search(query, { repo, taskKind, limit? })` → `{ id, title, kind, body, score }[]`
- `propose(input, { actor, repo, taskKind, packages? })` → `{ id, status, duplicateOf? }`

`knowledge.search { query, limit? (default 5) }` prints `[id] kind: title (score)` with each body trimmed to its share of the budget. `knowledge.propose { title, body, kind?, topics?, packages? }` returns `proposed <id> (<status>)` or the duplicate it matched.

### External: Context7

`context7Server({ transport?, apiKey? })` returns an SDK `mcpServers` entry named `context7`: by default the hosted server at `https://mcp.context7.com/mcp` (`Authorization: Bearer <key>` when a key is given), or `npx -y @upstash/context7-mcp [--api-key <key>]` with `transport: 'stdio'`. Its tools are `resolve-library-id` and `query-docs`. `externalServers(settings)` returns it only when `agent.tools.context7` is `true`; it is off by default because it calls an external service.

## Why this saves tokens

- **Structure first.** `code.outline` costs one line per declaration; the agent then reads a 20-line range with `code.read` instead of a 600-line file.
- **Matches, not files.** `code.search`, `code.symbol` and `code.references` return locations with a few lines of context, so locating code does not mean reading it.
- **Exact versions.** `docs.package` answers from what is installed and only for the version step that matters, instead of the agent opening `node_modules` or relying on stale training data.
- **Graph lookups.** Blast radius comes from the prebuilt import graph instead of repeated greps.
- **Bounded output.** Every result is capped and marks truncation, so a broad query costs at most `maxResultLines` and tells the agent to narrow it.
- **Stable prompts.** The Claude adapter keeps the system prompt independent of the run (see `@holtkeeper/agent`), so the tool list and context block are cached across runs.

## Limitations

- Symbol tools are syntactic: same-named identifiers in different scopes are not told apart, and re-exports under another name are not followed.
- The module graph covers files under workspaces' `src/` only.
- The migration view relies on version numbers in headings; guides without them return the section list.
