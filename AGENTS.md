# Agent guide

Instructions for AI agents and humans working in this repository. Read [docs/PLAN.md](docs/PLAN.md) for the product picture and [docs/development.md](docs/development.md) for tooling.

## Commands

- `bun install` — install dependencies (also installs git hooks)
- `bun run check` — everything CI runs: format check, lint, typecheck, tests, knip
- `bun test` — tests; `bun test packages/core` for one module
- `bun run fmt` — format in place
- `bun apps/cli/src/bin.ts <command>` — run the CLI from source

Run `bun run check` before considering a change done.

## Layout

- `apps/*` — runnable entry points (CLI, server, web)
- `packages/*` — libraries: contracts (`core`, `forge`, `exec`, `vuln`) and their implementations (forge adapters, scanners, fixers, ...)
- `plugins/*` — automations built on the plugin contract from `@holtkeeper/core`
- `docs/` — project-wide docs; every module also has its own `docs/` folder
- `fixtures/` — small vulnerable projects for integration tests; tests copy them to a temp dir before changing anything

Dev tools beyond Bun (osv-scanner, Go, pnpm) are pinned in `mise.toml`; run commands through `mise exec --` if they are not on your PATH. Integration tests that need such a tool use `test.skipIf(!Bun.which('tool'))`.

## Rules

- **No build step.** Packages export TypeScript source (`"exports": { ".": "./src/index.ts" }`) and Bun runs it directly. Do not add `dist/`, bundlers or declaration emit for libraries.
- **Erasable syntax only.** No `enum`, `namespace`, parameter properties or other TypeScript that needs code generation (`erasableSyntaxOnly` enforces this). Import with explicit `.ts` extensions and `import type` for types.
- **Depend on interfaces.** Plugins talk to `GitForge`, never to GitLab or GitHub clients directly. Provider specifics stay in adapter packages.
- **English** in all files: code, comments, docs, commit messages.
- **Document contracts.** Every exported interface, type and function that other modules use gets a TSDoc comment saying what it guarantees — not how it works. Inside function bodies, comment only decisions a reader could not infer (a tool quirk, a deliberate trade-off).
- **Contracts first, implementations replaceable.** Modules depend on interfaces from contract packages (`@holtkeeper/forge`, `@holtkeeper/vuln`, `@holtkeeper/exec`), never on each other's implementations. Anything that shells out takes a `CommandRunner`, so tests use `createFakeRunner` from `@holtkeeper/exec/testing`.
- **Tests sit next to the code** as `*.test.ts` and use `bun:test`. Integration tests and fixtures live in the module's `test/` folder.
- **Docs move with code.** A change to a module's behavior or public API updates that module's `docs/` in the same change.
- **Commits and MR titles:** one line in Conventional Commits form (`feat(core): ...`, `fix(forge-gitlab): ...`), no body.

## Adding a module

1. Create `packages/<name>/` (or `apps/`, `plugins/`) with `package.json` named `@holtkeeper/<name>`, `"type": "module"` and `exports` pointing at `src/index.ts`.
2. Add `src/index.ts`, tests and `docs/README.md` describing what the module does and its public API.
3. Reference other workspace packages as `"workspace:*"`.
4. Link the module from [docs/README.md](docs/README.md).
