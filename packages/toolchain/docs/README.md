# @holtkeeper/toolchain

Works out which tools (by their [mise](https://mise.jdx.dev) names) and versions a repository needs, from the files it already has. Pure: it only reads files, never runs anything.

```ts
import { detectToolchain, mergeToolchain, miseExecArgs } from '@holtkeeper/toolchain'

const detected = await detectToolchain(checkoutDir) // optionally pass the repository's file list
const toolchain = mergeToolchain(detected, scopedSetting) // the `toolchain` setting, may be undefined
miseExecArgs(toolchain) // ['mise', 'exec', 'node@20', 'pnpm@9.12.0', '--']
```

## Detection

`detectToolchain(dir, files?)` returns `{ tools: { name, version, source }[], packageManager?, notes }`. One entry per tool; `source` is the repository-relative file that decided it. Sources, highest priority first:

| Source                                                            | Gives                                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mise.local.toml`, `mise.toml`, `.mise.toml`, `.config/mise.toml` | `[tools]` (string, array → first, `{ version }`); `system` is skipped                                      |
| `.tool-versions`                                                  | every line; asdf names `nodejs`/`golang` become `node`/`go`                                                |
| `package.json#packageManager`                                     | corepack style `pnpm@9.12.0+sha512…` → `pnpm 9.12.0` (also `packageManager`); `npm` is not a separate tool |
| `.nvmrc`, `.node-version`                                         | `v20` → `20`, `lts/*` → `lts`, `lts/iron` → `20`, `node` → `latest`                                        |
| `package.json#engines.node`                                       | newest even (LTS) major inside the range, e.g. `>=18 <23` → `22` — only when nothing else names node       |
| `package.json#volta`                                              | `node`, `pnpm`, `yarn`                                                                                     |
| `bun.lock`, `bun.lockb`                                           | `bun` at the `packageManager` version or `latest`                                                          |
| `go.mod`                                                          | `toolchain go1.x.y`, else `go 1.x`                                                                         |
| `.python-version`                                                 | first line                                                                                                 |
| `pyproject.toml`                                                  | newest known 3.x inside `requires-python` / Poetry's `python`; `[tool.poetry]` implies `poetry`            |
| `rust-toolchain.toml`, `rust-toolchain`                           | `channel`                                                                                                  |
| `.java-version`, `.sdkmanrc`                                      | `java` (SDKMAN `21.0.2-tem` → `temurin-21.0.2`), `maven`, `gradle`, ...                                    |
| `.ruby-version`                                                   | `ruby-3.3.0` → `3.3.0`                                                                                     |

Without a pinned version, some files imply a default (reported in `notes`): `package.json` → `node lts`, `pnpm-lock.yaml` → `pnpm latest`, `yarn.lock` → `yarn 1` (classic lockfile) or `latest`, `uv.lock` → `uv`, `poetry.lock` → `poetry`, `Cargo.toml` → `rust stable`. Lockfiles also set `packageManager` when the field is missing.

Ranges (`engines.node`, `requires-python`) are constraints: a pinned version from any other file wins, and a pin outside the range becomes a note. Disagreeing files become notes too (`.nvmrc asks for node 18; using 20 from mise.toml`). Malformed files are noted and skipped; detection never throws.

**Monorepos.** Directories below the root that contain one of `toolchainFiles` are sub-projects: from `files` when given (repository-relative paths, e.g. from `git ls-files`), otherwise found by walking three levels deep (skipping dot directories, `node_modules`, `vendor`, `target`, `dist`, `build`, `out`). The root wins for every tool it names; sub-projects add tools the root does not name (first in path order), and conflicts are reported as notes with the sub-project path. Implied defaults apply only after all sub-projects, so `packages/a/.nvmrc` beats a root `package.json` without a version.

## Override

The scoped setting `toolchain` (`toolchainSetting`, section `Runtime`, schema `toolchainOverrideSchema`) is shaped like `SettingDefinition` from `@holtkeeper/settings` without depending on it:

```ts
{
  tools?: Record<string, string>   // replaces detected versions; 'none' removes a tool
  image?: string                   // container image for these repositories
  network?: 'none' | 'install' | 'full'
  env?: Record<string, string>     // passed to every command, never baked into an image
}
```

`mergeToolchain(detected, override)` returns an `EffectiveToolchain` (the toolchain plus `image`, `network`, `env`); overridden tools get `source: 'setting'`.

## Helpers

- `miseExecArgs(toolchain)` / `miseToolSpecs(toolchain)` — `mise exec <name@version>… --` and the bare specs for `mise install`.
- `nodeVersion`, `nodeMajorFor(range)`, `pythonRange`, `pythonMinorFor`, `sdkmanJava` — the version translations above. `nodeMajorFor` considers majors up to `latestNodeMajor` (bump it when a new LTS line appears).
