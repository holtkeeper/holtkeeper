# @holtkeeper/guide-generator

The Guide generator: the `guide` analyzer writes the generated layer of the `general`, `testing`, `testids` and `commits` sections of a repository's [Guide](../../guide/docs/README.md) from deterministic evidence. A person accepts the result before agents rely on it.

Research on context files found that rules people write help agents while LLM-written ones alone make them slightly worse, so the generator stays narrow: it only words facts Holtkeeper collected deterministically, it is told to state nothing the evidence does not show and no generic advice, and the resolver always ranks its text below every human layer under "Generated from repository signals, lower priority; …".

## Evidence

Collectors read the checkout (and earlier analyses) and return `Evidence { id, label, text }` items, each at most about 1 500 characters. They never dump code; the only source text is the first 30 lines of at most three test files.

| Section   | Collector                               | Items                                                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general` | `collectGeneral(dir, files)`            | `manifests` (package.json name, workspaces, scripts, dependency names; go.mod; Makefile targets; pyproject; nested manifests), `ci` (GitLab CI stages and jobs, GitHub workflows), `lint` (lint/format/hook configs, tsconfig options), `toolchain` (`detectToolchain`), `layout` (top-level folders and root files), `docs` (existing docs with their titles) |
| `testing` | `collectTesting(dir, files, coverage?)` | `test-setup` (`detectTestSetup` of `@holtkeeper/quality-tests`: frameworks, conventions, test file count), `test-scripts`, `test-head:<file>` (up to three), `coverage` (line coverage by folder from the newest `coverage` record)                                                                                                                            |
| `testids` | `collectTestIds(catalog?)`              | `testids-attributes`, `testids-naming` (naming style of literal values with real examples), `testids-elements` (tags that carry attributes), from the newest `testids` record                                                                                                                                                                                  |
| `commits` | `commitsText(conventions)`              | The rules of `commitConventions` (commitlint, push rules, recent history) rendered as bullets. No LLM. Examples and counts are left out so the text changes only when a rule does.                                                                                                                                                                             |

Large counts are rounded to two significant digits (`approx`), counts under 100 lines read `under 100` and coverage is given in 10% bands, so the evidence, and its hash, does not change with every added file or test. A section without evidence is skipped.

## Hash gate and the one call

`sectionHash(section, evidence, steering)` hashes the evidence, the section's steering (from every scope of the repository, strongest first) and `GENERATOR_VERSION`. When it equals the hash of the section's latest generated text (the pending proposal, else the generated layer), nothing is called (`unchanged`). Team rules and the one-off extra prompt are not part of the hash: editing rules or regenerating by hand does not make the next scheduled run spend again.

`generateGuide` sends every changed LLM section of a repository in **one** agent call with no tools and its own `context` (`GENERATOR_CONTEXT`), so the server does not add the Guide (the generator's own earlier text included) to it: tier `main` when `general` is among them, otherwise `fast`, capped at `CALL_CAPS` ($0.50 / $0.10). The prompt (`GENERATOR_SYSTEM`, `generatorPrompt`) asks for concise imperative bullets that follow from the evidence, forbids generic best practices, passes each section's steering ("follow it") and team rules ("do not repeat or contradict"), and appends the extra prompt when there is one. The answer is JSON (`generatorOutput`); `renderBullets` strips list markers, drops blanks and duplicates and cuts at a whole bullet within `SECTION_CHARS` (1 200). The call's cost is split evenly over its sections. `commits` is written from its text with model `deterministic` and cost 0.

Budget: the agent the job gets is metered, so an automatic run is refused once the week's spend reaches `weeklyUsd − reserveUsd` and a manual one at `weeklyUsd`. The `BudgetExceededError` propagates, the job ends `blocked`, and nothing of the run is stored.

## Proposals and acceptance

New text is stored on the repository scope's section (`placeGenerated`):

- without accepted text it becomes `generated` with `status: proposed`; agents get it only while no human rules apply and the repository has no rules files;
- over accepted text it becomes `proposal`, and agents keep the accepted `generated` text until a person accepts the proposal (`POST /api/guide/section/accept`);
- when it equals the accepted text, or is empty (the model found nothing specific), the accepted layer only takes the new hash and commit (`kept`); empty text is never accepted (409).

Every layer records `inputHash`, `model`, `costUsd`, `generatedAt`, `sha`, the run's extra `prompt` and the `jobId` of the run (`GenerateInput.jobId`, from the analyzer context). The generator writes layers without a `version` (`GuideGeneratedInput`): `Store.guides.put` numbers every new layer with the section's next version and appends it to the generated history (`store.guides.generatedHistory`), so each proposal of each run stays comparable later; a kept layer keeps its version. The panel compares two versions (`GET /api/guide/generated/history`). `pendingGenerated(row)` is the text waiting for acceptance; `latestGenerated(row)` the one the hash gate compares with.

## Rejections

A person may reject the waiting text instead (`POST /api/guide/section/reject`). `rememberGuideRejection(kv, scope, section, { inputHash, generatedAt, by, at })` stores a reference to that version in `Store.kv` (key `guide:rejected:<scope>:<section>`, the newest 50 per section); the stored section is not changed, so the version stays where it is for a later version history. `guideRejections` and `rejectedHashes` read them back. The analyzer passes the rejected hashes of each section to `generateGuide` (`SectionInput.rejected`): a section whose hash a person rejected is `skipped` with the reason `a person rejected text from these inputs`, even on a forced run; changed evidence or steering gives a new hash and proposes anew. The server hides rejected text from its Guide views and from Inbox. The resolver still reads stored sections as they are, so a rejected first proposal (`generated` with `status: proposed`) reaches agents while no human rules apply, until a newer run replaces it.

## Analyzer

`createGuideAnalyzer({ store, groupsOf })` returns the `guide` analyzer (repository scope, needs a checkout; forge, agent and history optional; runs `after` `coverage` and `testids`). The server builds it with its store; the copy in `builtinAnalyzers` has none and refuses to run. Options:

- `sections` — the sections to consider (default all four);
- `prompt` — a one-off extra prompt, stored with what the run writes;
- `force` — regenerate even when hashes are unchanged (the panel's Regenerate, `POST /api/guide/regenerate`, sets it).

These options are set per run only: `guide` has no `analyzers.guide` setting and `POST /api/jobs` refuses it, so jobs come from the schedule and `/api/guide/regenerate`. A job with a `ref` fails: the Guide is generated from the default branch only. The analyzer sets `defaultBranchOnly`, so tag, push and merge request triggers and policies (whose jobs carry a ref) leave it out; the default `new-repo` trigger runs it once.

Without an agent the LLM sections are skipped; without a forge `commits` is. Each run is stored as a `guide` analysis record (`GuideRunData`: per section the outcome, hash, evidence ids and skip reason; the call's tier, model and cost; the extra prompt). Freshness reruns it at most weekly once the default branch moved (`refresh: { on: 'change', minInterval: '7d' }`), only when its latest record names a commit and the weekly budget for automatic work allows; it is still hash-gated.
