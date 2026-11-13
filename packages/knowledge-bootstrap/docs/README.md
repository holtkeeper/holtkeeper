# @holtkeeper/knowledge-bootstrap

The `knowledge-bootstrap` analyzer: starter knowledge for a repository the knowledge base knows nothing about. One AI call reads the repository's code and its recent merge requests the way a new teammate would and proposes 3–10 concrete lessons (decisions, conventions, quirks, how-tos) with evidence links. A deterministic step, the scope agreement of [@holtkeeper/knowledge](../../knowledge/docs/README.md#scope-agreement), places each lesson at repository, subgroup or group level. Everything lands as proposals in the Knowledge Inbox; nothing is accepted without review.

```ts
import { createKnowledgeBootstrapAnalyzer } from '@holtkeeper/knowledge-bootstrap'
```

## When it runs

- **New repositories.** The default `new-repo` trigger runs every read-only repository analyzer once, so this one too. Its `appliesTo` (`bootstrapBlocker`) is false when the repository carries the `bootstrapMarker` (`knowledge:bootstrap:<forge>:<path>` in `Store.kv`) or a proposed or accepted entry names it exactly (`forge:path` or the bare path; group, glob and `all` scopes do not count). Library lessons other repositories' runs scoped to it (author `agent:knowledge-bootstrap`, with a `subject`) do not count, so a library's home is still bootstrapped from its own code.
- **At most `DAILY_RUNS` (10) a day.** The analyzer declares `dailyLimit: 10`: when a trigger or schedule queues it for many repositories at once (a new group, **Run now** on the new-repository trigger), the queue gives the jobs beyond ten per UTC day a `runAfter` on the next days. Worst case $4 a day on `main` (ten capped calls), usually about $1.20, so a large fleet cannot use up the week's automatic budget in one go. Installs whose new-repository trigger lists analyzers get it added once (`new-repo+knowledge-bootstrap`).
- **By hand.** Run the analyzer on a repository (`POST /api/jobs`, Settings › Analyzers › Run). Manual runs skip `appliesTo`, so `run` checks again; `force: true` repeats a run on a marked repository or one with entries. For an existing fleet, an Automation schedule with this analyzer and **Run now** covers a group; repositories already done are skipped.
- **Never on its own again.** It declares no `refresh`, and every run that gets past the check marks the repository (`{ at, jobId, proposed, promoted, reason: 'bootstrapped' }`). A repository found with entries of its own is marked with `reason: 'has-entries'` and skipped. Runs without an agent, refused by the budget or failing leave no marker.
- `repo.analyzers` turns it off per group or repository, like any analyzer.

Default branch only (a `ref` is refused), not `exclusive` (it writes Holtkeeper's database, never the repository), keeps the newest 10 records.

## Evidence

Deterministic and capped; the whole prompt stays around 60 000 characters.

| Part                          | Cap             | What                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collectCodeEvidence`         | 18 000 chars    | `collectGeneral` of [@holtkeeper/guide-generator](../../guide-generator/docs/README.md) (manifests, Makefile targets, CI, lint, toolchain, layout, docs list), the README without badges (3 000), up to 3 docs files (CONTRIBUTING, ARCHITECTURE, DEVELOPMENT, then `docs/*.md`, 1 500 each), up to 6 ADRs (title and 400 chars), the Go package layout |
| `collectMergeRequestEvidence` | 24 000 chars    | merged merge requests of the last `months` (at most `maxMergeRequests`), without bot authors and dependency updates: an `mr-titles` item (80 titles, 5 000 chars) and for the newest `discussionMergeRequests` one `mr:<id>` item (2 000) with the description, template stripped (600), and the review threads                                         |
| existing entries              | 30, 9 000 chars | proposed and accepted entries of the repository's root groups (same subgroup first, then group entries, then newest), listed with their `kb:<id>` so the model can link them in `related`                                                                                                                                                               |
| fleet libraries               | 30              | packages fleet repositories own (server: the public API catalog) that the repository depends on directly (`go.mod` requires, `package.json` dependencies up to two folders deep), with their home repository                                                                                                                                            |

Review threads name people by role only: the merge request's author is `author`, everyone else `reviewer 1`, `reviewer 2`, ... System notes and bot notes are dropped (Holtkeeper's own bot, `[bot]`, `-bot`, project and group bot accounts, Renovate, Dependabot). Threads with replies come first, then comments on a diff line (`path:line`), then general comments; notes are cut at 500 characters and code blocks over 300 characters are replaced by a marker. A forge that cannot list merge requests gives code evidence only; a failing discussions read is logged and skipped. Forge calls: one listing plus at most `discussionMergeRequests` discussion reads, one after another.

## The call

`generateLessons` makes one agent call with no tools (the server mounts no toolsets for `knowledge-bootstrap`, so text in the repository or its merge requests cannot make the model write entries itself), at most two turns, its own `context` (`BOOTSTRAP_CONTEXT`, so the server adds neither the Guide nor the knowledge block), `taskKind: 'knowledge-bootstrap'` (spend shows under **Guide and learnings**), the tier's cap (`CALL_CAPS`: `main` $0.40, `deep` $1.00) and an estimate (`estimateBootstrapCost`) as `estimateUsd`, which the weekly budget check weighs before anything is spent. The log starts with `budget: estimate $0.12, cap $0.40 (tier main, ~16k input tokens)`.

The estimate uses reference prices (`REFERENCE_PRICES`: `main` $3 / $15, `deep` $5 / $25 per million input / output tokens), four characters per token and 500 output tokens per requested lesson. A full prompt costs about **$0.12 on `main`** and about $0.21 on `deep`; bootstrapping 60 repositories is about $7, roughly 5% of a $150 week. When the budget refuses the run (or the cap stops it) the `BudgetExceededError` propagates: the job ends `blocked` with the worker's `blocked by budget: …` line, nothing is stored and no marker is written, so a later run (by hand from the blocked runs) still works.

The model answers `bootstrapOutput`: lessons with `title`, `body`, `kind`, `topics`, `evidence` ids, `level` (`repo`, `process`, `library`), `library`, `repoSpecific`, `related` and `general`. `acceptLessons` checks it deterministically: unknown evidence ids are dropped and a lesson left with none is dropped (`dropped "…" — no known evidence`); a `library` that is not a direct dependency makes it a repository lesson; `related` keeps only ids the prompt listed; a migration without a library becomes a how-to; the list is cut to `maxEntries`. Cited evidence becomes links: `mr:<id>` the merge request, a file its blob at the checkout's commit, other items the tree at that commit, `mr-titles` the merged list (GitLab and GitHub URLs; other forges get no links).

## Placing and proposing

After the call the analyzer reads the knowledge base again (siblings bootstrapped meanwhile count, rejected entries included so a refused promotion is not proposed again), runs `placeLessons` and writes each decision:

- `create` → `proposeEntry` as `agent:knowledge-bootstrap`, `appliesTo: ['*']`, no `autoAccept`, with `supersedes` for promotions and every generalised match in `notDuplicates`, so a promotion over two siblings is not swallowed as the duplicate of the one it does not supersede. Duplicates count only among entries of the repository's team (`reachesRepoRoots`) or of the same library subject; a duplicate creates nothing and merges evidence.
- `covered` → `mergeEvidence` into the entry that already covers the repository; when that entry is gone by then the lesson is `dropped`.
- A proposal the entry rules refuse (`KnowledgeValidationError`) is `dropped` with the issues.

Starter knowledge is never auto-accepted, whatever `knowledge.autoAccept` says: the team reviews it in the Inbox. Accepting a promoted entry archives the sibling entry it supersedes.

Each lesson gets one log line:

```
proposed [repo] "Run generators through make gen" — no matching entry in its groups
proposed [subgroup shapes.round] "Generate mocks with make gen" — a sibling in shapes.round has it: matches kb:1a2b3c4d (repo work:acme/widget-api, overlap 0.62); supersedes kb:1a2b3c4d
proposed [group shapes] "Squash merge requests" — team process: matches kb:5e6f7a8b (repo work:acme/gadget-api, linked)
proposed [library Go:example.com/kit → work:acme/kit] "Wrap kit clients in kit.Retry" — how to use Go:example.com/kit, whose home is work:acme/kit
covered by kb:9c0d1e2f [group shapes] "…" — evidence merged (1 new)
duplicate of kb:3a4b5c6d "…" — evidence merged
dropped "…" — no known evidence
```

## Options

The `analyzers.knowledge-bootstrap` setting (Settings › Analyzers, per group or repository) and the options of a manual run:

| Option                    | Default | Meaning                                                             |
| ------------------------- | ------- | ------------------------------------------------------------------- |
| `months`                  | 6       | How many months of merged merge requests to read (1–24)             |
| `maxEntries`              | 10      | Most lessons (1–10)                                                 |
| `promote`                 | true    | Apply the scope agreement; off keeps every lesson at the repository |
| `maxMergeRequests`        | 60      | Most merged merge requests listed (0–200)                           |
| `discussionMergeRequests` | 25      | Most merge requests whose review threads are read (0–50)            |
| `tier`                    | `main`  | `main` or `deep`                                                    |
| `force`                   | false   | Run on a marked repository or one with entries                      |
| `prompt`                  | —       | One-off extra request, stored with the record                       |

## API

- `createKnowledgeBootstrapAnalyzer({ store?, groupsOf?, botUsername?, fleetPackages?, now? })` — the analyzer. Without `store` (the registry copy in [@holtkeeper/analyzers](../../analyzers/docs/README.md)) `appliesTo` answers true and `run` refuses; the server builds the real one.
- `knowledgeBootstrapAnalysis` — the analysis kind: `KnowledgeBootstrapData { outcome, reason?, window?, evidence, lessons: { title, level?, scope?, outcome: created | duplicate | covered | dropped, entryId?, duplicateOf?, supersedes?, why }[], call?, version?, prompt? }`; the report has a Lesson · Level · Scope · Outcome · Why table and the metrics proposed, promoted and cost.
- `bootstrapBlocker(store, repo)` — `marked` (with the mark), `has-entries` or `undefined`.
- `BOOTSTRAP_ACTOR`, `DAILY_RUNS`, `EXISTING_ENTRIES`, `FLEET_LIBRARIES`.
- `collectCodeEvidence(dir, files)`, `directDependencies(dir, files)`, `collectMergeRequestEvidence(input)`, `renderDiscussions`, `stripTemplate`, `isBot`, `isDependencyUpdate`.
- `bootstrapPrompt`, `BOOTSTRAP_SYSTEM`, `BOOTSTRAP_CONTEXT`, `BOOTSTRAP_VERSION`, `bootstrapOutput`.
- `generateLessons`, `acceptLessons`, `evidenceLink`, `estimateBootstrapCost`, `CALL_CAPS`, `REFERENCE_PRICES`.

## Limitations

- The match thresholds are heuristics; lessons that say the same thing in different words may stay at repository level for people to merge.
- Repositories bootstrapped at the same moment can miss each other's entries and leave two repository proposals instead of one promotion.
- A run the weekly budget refuses ends `blocked` without a marker; the next new-repository trigger run queues it again (within the daily limit).
- A library lesson scoped to the library's home repository reaches agents in other repositories through its subject (search, `evaluate_dependency`), not through their own scope.
- Promotions need subgroups that reflect how the team works: split groups into subgroups before bootstrapping a fleet.
- It imports `collectGeneral` from `@holtkeeper/guide-generator` rather than a contract package; both read the same deterministic repository facts.
