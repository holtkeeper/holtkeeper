# @holtkeeper/review-tests

The `MergeRequestTester` the review's `tests` option uses: the agent writes a test for each function a merge request changes, and Holtkeeper runs it itself in the job's sandboxed runner. A verdict is what the runs showed, never what the agent says.

```ts
import { createReviewAnalyzer } from '@holtkeeper/review'
import { createMergeRequestTester } from '@holtkeeper/review-tests'

const review = createReviewAnalyzer({ tester: createMergeRequestTester() })
// run with { mergeRequest: 7, tests: true }
```

## `createMergeRequestTester(options?)`

| Option           | Default | Meaning                                                        |
| ---------------- | ------- | -------------------------------------------------------------- |
| `install`        | `true`  | install JavaScript dependencies when `node_modules` is missing |
| `installScripts` | `false` | let that install run lifecycle scripts                         |
| `build`          | `true`  | build workspace packages whose entry files are missing         |
| `minLines`       | 3       | in-scope added lines a function needs to get a test            |

The limits per run (`maxTests`, `repeat`, `timeoutMs`, `attempts`) come from the review options.

## Steps

1. **Setup** — `detectTestSetup` (from `@holtkeeper/quality-tests`) finds the framework and the project's test conventions. No framework: the run is `skipped`.
2. **Carry-over** — tests of the previous review whose function still has the same text (`functionHash`) and whose test file is still not in the repository are kept as they were, with their `ranAt`.
3. **Targets** — `findTargets`: the outermost functions (`findFunctions`, `outermost`) of changed source files with at least `minLines` in-scope added lines; test files, generated and excluded files and type-only TypeScript are left out. Ranked by added lines, then branches; the first `maxTests` are tested, the rest are `notTested`. Functions in a language without a detected framework are `notTested` too.
4. **Preparation** — for JavaScript targets, `installDependencies` and `buildWorkspaces` from `@holtkeeper/coverage`. A failure makes the run `skipped` with its last output lines.
5. **Baseline** — when the conventional test file of a target's source already exists, it is run once; a target whose existing test fails on the head gets no new test (`notTested`), since nothing could be concluded from it.
6. **Writing** — the agent (`taskKind: 'tests'`, `read` and `search` only, never `run` or `edit`) answers with `{ path, content, notes }` to `writePrompt`: the `quality-tests` example prompt plus the MR title, description and the numbered diff of the function. The path must follow the project's convention (`testPathProblem`), must not exist and must not be taken by another test of the run.
7. **Running** — Holtkeeper writes the file and runs `singleTestCommand` from the nearest folder with the language's project file (`package.json`, `go.mod`; `testCommand`), with `CI=true` and `timeoutMs`. A failed run goes back to the agent with the tail of the output (`fixPrompt`); it answers `fixed` with the whole file or `code-wrong` with why. At most `attempts` rounds.
8. **Repeat** — a passing test runs again until `repeat` runs: all passed → `passes`, some → `flaky`. A test that never passed, or that the agent judged the code wrong for, is `unfinished` with the `reason`.
9. **Cleanup** — the test file, or the outermost folder created for it, is removed after its runs, also on errors. Nothing else in the checkout is written.

## Other exports

`runTest`, `testCommand`, `tail`, `findTargets`, `outermost`, `functionHash`, `targetId`, `writePrompt`, `fixPrompt`, `fixSchema`, `targetDiff`, `SYSTEM`.

## Limitations

- One test file per function: two functions of one source file get two files, the second under another name.
- Go runs the whole package of the test file, so the package's other tests count into the verdict.
- A test passing on the head does not yet prove it checks the change; running it against the base version is phase 2 of [the design](../../review/docs/design-mr-tests.md).
