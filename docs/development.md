# Development

## Setup

Bun is pinned in `package.json` (`packageManager`) and `mise.toml`. With [mise](https://mise.jdx.dev):

```sh
mise install
bun install
```

`mise install` provides Bun plus the tools integration tests use: osv-scanner, Go and pnpm. Tests that need a missing tool are skipped.

`bun install` also installs the lefthook git hooks: staged files are formatted and linted, and the project is type-checked before each commit.

## Tooling

| Tool                                        | Command                            | Config           |
| ------------------------------------------- | ---------------------------------- | ---------------- |
| Bun — runtime, package manager, test runner | `bun test`                         | `package.json`   |
| TypeScript 7 (native) — type checking only  | `bun run typecheck`                | `tsconfig.json`  |
| oxlint with type-aware rules                | `bun run lint`                     | `.oxlintrc.json` |
| oxfmt                                       | `bun run fmt`, `bun run fmt:check` | `.oxfmtrc.json`  |
| knip — unused files, exports, dependencies  | `bun run knip`                     | `knip.json`      |
| lefthook — git hooks                        | runs on commit                     | `lefthook.yml`   |

`bun run check` runs everything CI runs.

To run a local instance, `bun run dev:seed` creates a SQLite store with sample data and `bun run dev:server` starts it (`holtkeeper serve` with `examples/dev/holtkeeper.config.ts`); `bun run dev:web` serves the web UI with hot reload. On an instance with passkey sign-in, `holtkeeper users login-link` signs an agent in ([agent-access.md](agent-access.md)).

A single `tsconfig.json` at the root covers every workspace. TypeScript 7 checks the whole repository in well under a second, so there are no project references.

## No build step

Libraries are not compiled. Every package exports its TypeScript source:

```json
{ "exports": { ".": "./src/index.ts" } }
```

Bun runs `.ts` files directly — from the workspace and from `node_modules` alike — so the server (started by the CLI's `serve`) and tests run from source, and so do consumers such as the private configuration repository.

What this gives us:

- no `dist/` to keep in sync, no watch mode, no source maps to debug through;
- go-to-definition lands in real source;
- `tsc` is only a checker (`noEmit`), which is where TypeScript 7 is fastest.

What it costs, and how we handle it:

- **Consumers must run Bun.** Node refuses to strip types inside `node_modules`. This is acceptable: Holtkeeper is a Bun application, not a general-purpose library.
- **Consumers type-check our source.** `skipLibCheck` does not apply to `.ts` files, so a consumer's compiler options apply to our code. We use strict settings, so the usual strict configurations work; `exactOptionalPropertyTypes` in a consumer may need `skipLibCheck`-like isolation later.
- **Only erasable syntax.** `erasableSyntaxOnly` bans `enum`, `namespace` and parameter properties, which keeps the source valid for any type-stripping runtime if we ever need one.
- **Things that are not libraries still get bundled.** The web UI is bundled by Bun when served. The server ships as a container image that runs `holtkeeper serve` from source.

## Documentation

Project-wide docs live in `docs/`. Each module documents itself in its own `docs/` folder, starting with `docs/README.md`, and is listed in [docs/README.md](README.md).
