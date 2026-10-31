# @holtkeeper/analyzer

The contract between analyzers and the runners that run them (the CLI, the task engine of `@holtkeeper/jobs`). An `Analyzer` declares its kind, scope (`repo` or `group`), options schema and what it `needs` (checkout, forge, agent, history); runners provide exactly that in an `AnalyzerContext` and store what `run` returns.

## Applicability

`appliesTo?: Applicability` says whether a repository uses what the analyzer works on. Schedules ask it before queueing a repository job, so an analyzer in a schedule over every group runs only where it has something to do, and repositories that start or stop using it join or leave on the next run. It reads the default branch through the forge (`ApplicabilityContext`: `repo`, `forge.readFile`), never a checkout, so keep it to a few small files. A check that throws counts as applying; manual runs skip the check, so `run` must still handle a repository it does not apply to.

Building blocks, combinable:

| Check                             | Applies when                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `hasFile(...paths)`               | any of the files exists                                                               |
| `fileContains(paths, text \| re)` | any of the files contains the text or matches the expression                          |
| `lockfileHasPackage(name)`        | a root JavaScript lockfile (`jsLockfiles`: bun, pnpm, yarn, npm) resolves the package |
| `anyOf(...checks)`, `allOf(...)`  | any / every check applies, evaluated in order and stopping early                      |

```ts
defineAnalyzer({
  kind: 'browserslist',
  appliesTo: lockfileHasPackage('caniuse-lite'),
  // ...
})
```

## Optional needs

`forge`, `forgeAccess` and `history` take `true` (the runner must provide it) or `'optional'` (provided when the runner can, and `run` copes without it). The task engine provides all three; for `'optional'` forge access it skips a forge that gives no token instead of failing the job. The CLI provides none of them, so it refuses analyzers that need one with `true` and runs those that only take them as `'optional'`.

## Forge access

`needs.forgeAccess` gives `context.forgeAccess` (`ForgeAccess`): the forge's `kind`, base `url` and API `token`, its `fetch` with the per-token rate limits (send the tool's API calls through it), the forge's SSH signing key with its identity when it has one, and `readOnly` for repositories Holtkeeper must not change. It is for analyzers that hand the forge to an external tool, such as [@holtkeeper/renovate](../../renovate/docs/README.md); everything else uses `context.forge`. Pass the token to the tool through its environment, never in files or logs, and push nothing when `readOnly` is set.

## Panel editor

`editor` names a dedicated panel editor for the analyzer's `analyzers.<kind>` setting (`renovate`), instead of the form generated from `options`.
