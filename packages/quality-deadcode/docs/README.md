# @holtkeeper/quality-deadcode

The `deadcode` quality check: runs [knip](https://knip.dev) 6 on a JavaScript/TypeScript project and turns its JSON report into `QualityIssue`s and `review` `CodeChange`s that delete unused files, drop unused dependencies and stop exporting unused exports.

## Public API

- `deadCodeCheck({ production?, include?, command?, timeoutMs? }): QualityCheck` — check named `deadcode`. `detect(dir)` is true when `dir/package.json` exists. `run` calls `<knip> --version`, then `<knip> --reporter json --no-exit-code --no-progress` in `dir` through the context's `CommandRunner`, so knip reads the project's own configuration (`knip.json`, `knip.config.ts`, `package.json#knip`, ...) and falls back to its defaults. `production` adds `--production`, `include` adds `--include a,b`. `version` is `knip 6.x.y`. A non-zero exit (knip's configuration errors) or output without a JSON report throws. When `package.json` declares dependencies and `dir/node_modules` does not exist, `run` returns `skipped: 'dependencies are not installed'` without starting knip: knip then cannot load plugin configs that import packages (`webpack.mjs`), and reports every binary and transitively provided package as unlisted.
- `knipCommand(dir)` — the project's `node_modules/.bin/knip` when present (projects pin knip and its plugins), else the knip this package depends on, run with the current runtime. `knipArgs(options)` — the arguments above.
- `parseKnipReport(output)` / `knipReportSchema` — validates the reporter output (text printed before the report is skipped).
- `knipFindings(report, files: FileAccess): Promise<DeadCodeFindings>` — report to `{ issues, changes }`, reading file texts from `files`.
- `refineFindings(findings, dir): Promise<DeadCodeFindings>` — the refinement below.
- `removeDependencyEdit(text, file, field, name, at?)` and `removeExportEdits(text, file, targets)` — the edit builders, usable on their own.

## knip's JSON report

`{ issues: [{ file, files: [], dependencies: [], exports: [], duplicates: [[]], ... }] }` — one row per file with findings, `file` relative to the working directory. Symbols are `{ name, namespace?, line, col, pos }` with 1-based `line`/`col` of the name (in `package.json`, of the dependency name inside its quotes). Unused files appear as `files: [{ name }]` on their own row. knip 6 has no class-member type; `classMembers` is still accepted.

## Issues

All issues have tool `knip`, category `lint`, a `file` and — except for unused files — a `range` over the reported name. `id = stableId('knip', rule, file, namespace, name)`, independent of line numbers.

| knip type                            | Rule                                                             | Severity           |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------ |
| `files`                              | `deadcode/unused-file`                                           | `info`             |
| `dependencies`                       | `deadcode/unused-dependency`                                     | `info`             |
| `devDependencies`                    | `deadcode/unused-dev-dependency`                                 | `info`             |
| `optionalPeerDependencies`           | `deadcode/referenced-optional-peer`                              | `info`             |
| `unlisted`                           | `deadcode/unlisted-dependency`                                   | `warning`          |
| `unlisted`, provided by a dependency | `deadcode/transitive-dependency`                                 | `info`             |
| `binaries`                           | `deadcode/unlisted-binary`                                       | `warning`          |
| `unresolved`                         | `deadcode/unresolved-import`                                     | `warning`          |
| `exports` / `nsExports`              | `deadcode/unused-export` / `-namespace-export`                   | `info`             |
| `types` / `nsTypes`                  | `deadcode/unused-type` / `-namespace-type`                       | `info`             |
| `enumMembers`                        | `deadcode/unused-enum-member`                                    | `info`             |
| `namespaceMembers`                   | `deadcode/unused-namespace-member`                               | `info`             |
| `classMembers`                       | `deadcode/unused-class-member`                                   | `info`             |
| `duplicates`                         | `deadcode/duplicate-export`                                      | `info`             |
| `catalog` / `catalogReferences`      | `deadcode/unused-catalog-entry` / `unresolved-catalog-reference` | `info` / `warning` |
| `cycles` (with `include`)            | `deadcode/circular-dependency`                                   | `info`             |

## Refinement

`refineFindings(findings, dir)` runs on every report before it is returned:

- **Stories and tool configs are not unused files.** `*.stories.*`, `*.story.*`, `*.mdx`, `*.config.{js,ts,...}` and `.*rc.{js,ts,...}` are loaded by Storybook and other tools through globs or by name, which knip often cannot see (a Storybook config shared from a package, a tool without a knip plugin). Their unused-file issues and deletions are dropped.
- **One unlisted issue per package.** knip reports an unlisted package once per importing file; they become one issue per package that says how many files import it and names the first.
- **Transitive dependencies.** When a dependency declared in a `package.json` between the importing file and the project root depends on the unlisted package itself (an umbrella package such as `some-kit` bringing `some-lib`), the issue becomes `deadcode/transitive-dependency` with severity `info` and names that dependency: the code works, but relies on a package it does not list.

## Changes

Every change is `confidence: 'review'`, `source: 'knip'`, and is linked from its issues' `changeId`. Changes are split so people can pick:

- **One per unused file** — a `delete` edit whose `oldText` is the file read from disk.
- **One per unused dependency or devDependency** — a minimal `replace` edit of `package.json`: the entry's whole line with its trailing comma; for the last entry of an object, the comma before it instead; the only entry leaves `{}`. Single-line objects and CRLF files work. The result is parsed to confirm it is valid JSON without the entry; otherwise no change is proposed. Removals in one object combine through `planChanges`, except the last two entries together (both need the same comma) — that pair reports a conflict and applies on a second run.
- **One per file with unused exports or types** — removes the `export ` keyword of declarations (`const`, `let`, `var`, `function`, `function*`, `async`, `class`, `abstract`, `interface`, `type`, `enum`, `const enum`, `namespace`, `declare`), or the specifier from `export { a, b }` / `export type { ... } from '...'` lists; a list that loses every specifier goes as a whole statement. Edits never overlap.

Not changed automatically: default exports, namespace-scoped exports, enum/namespace members, unlisted and unresolved imports, duplicates. A `const`/`let`/`var` statement with several declarators (`export const a = 1, b = 2`) is un-exported only when knip reports every declarator; otherwise its issues get no change. Destructuring exports (`export const { a, b } = obj`) are never changed.
