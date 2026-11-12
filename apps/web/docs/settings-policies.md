# Settings › Policies

Part of the web app's [Settings](README.md#settings) docs.

Route `/settings/policies`, body `features/settings/sections/PoliciesSection.tsx`, draft logic in `lib/policy-draft.ts`, endpoints and hooks in `api/settings-analyzers.ts`. The pages that own these keys (Licenses, Security, Stack, Assets, Reviews, Coverage) keep editing the same entries; `knowledge.autoAccept` has no page and lives only here.

## Editing for a scope

A segmented control picks **Organization defaults** (entries scoped `{ all: true }`) or one group (entries scoped exactly `{ groups: [group] }`). Each card shows the value at that scope: its own entry, else (for a group) the organization's, else the setting's default, tagged "Inherited by Group …" until it is changed. Repository overrides stay in the Resolver; merge request policies and freshness stay in Ops › Automation.

Edits gather into one draft over every card (`PolicyDraft`: key → new value, or `null` to remove the scope's own entry with **Reset**). Setting a value back to the stored one drops it from the draft. **Save N changes** sends `draftChanges` to `POST /api/settings/draft` (all or nothing, one `setting.draft` audit event); **Discard** throws the draft away. The scope cannot change while the draft has edits. Without `settings:write` everything is read only.

## Cards

- **License policy** (`analyzers.licenses`): preset picker, three columns Allowed / Needs review / Denied (`allow`, `review`, `deny`), unknown licenses as Needs review or Denied (`unknown: warn | violation`), dev-only dependencies Checked too or Ignored (`devDependencies`), the repository license file switch, ignored packages, and an exceptions table (package, version, license, reason, approved by, until) with an inline form; new exceptions are approved by the signed-in person.
- **Security allowlist** (`audit.allowlistPolicy` and `audit.allowlist`): the longest an entry may last (`maxDays`, empty for no limit) and whether a reason is required, then the entries at the scope with Extend (expiry 30 days from today, or `maxDays` when shorter) and remove, and a form to add one. Entries added or changed in the draft show the problem the server would refuse them for (`allowlistRowProblem`, the same rule as the server).
- **Vulnerability fixes** (`audit.fix`, `audit.upgrade`): the fix switch and the largest upgrade.
- **Stack conventions** (`analyzers.stack`), **Asset policy** (`assets.policy`), **Commit conventions** (`commits.conventions`) and **Test ids** (`analyzers.testids`): the setting's own editor (`ValueEditor`, as in the entry dialog).
- **Tests** (`repo.tests`, homed on Quality › Coverage): a **Repositories have tests** switch and, while it is off, a reason field; it writes `{ expected }` or `{ expected: false, reason }` at the scope. A repository turns tests back on in the Resolver or from the Coverage sheet.
- **Analyzers off** (`repo.analyzers`, homed here: `settingsSections.policies.keys`; `AnalyzersOffPolicy`): toggles of the analyzers the definition's `off` enum offers, labelled from its `x-labels` (`analyzerOptions`), and, while one is off, a reason field; it writes `{ off }` or `{ off, reason }` (`analyzersOffValue`), keeping only offered kinds, so a stored kind the server no longer offers drops out on the next save instead of failing it. Off analyzers are never queued automatically and read **Off** in repository health and the hub overview. A repository turns them back on in the Resolver, where the generic form shows the same labelled toggles.
- **Merge request reviews** (`mergeRequests.comments`, homed here: `settingsSections.policies.keys`; `MergeRequestCommentsPolicy`): a **Review and comment on merge requests** switch and, while it is off, a reason field; it writes `{ enabled }` or `{ enabled: false, reason }`. Off: no AI review is queued and Holtkeeper posts nothing on the repositories' merge requests; nothing else in the panel changes (no badge or label), the repositories simply get no reviews. A repository turns it back on in the Resolver, where the generic form shows the same fields.
- **Agent knowledge** (`knowledge.autoAccept`, `learnings.autoAccept` and `guide.autoAccept`, homed here: `settingsSections.policies.keys`; `AgentKnowledgePolicy`): what is accepted without review. **Notes** toggles the knowledge kinds agents add at once; **Learnings** toggles the candidate sources (_Proposed over MCP_, _Review replies_) and whether they go to the _Suggested scope_ or the _Repository only_; **Generated Guide** toggles the sections whose generated text is accepted when the guide job writes it. Reset clears all three at the scope; the learnings and Guide rows carry their own `setting-<key>` anchors. Links to Knowledge, where the rest wait. Knowledge's Configure on the Notes tab lands here.
- Cards carry `setting-<key>` anchors (`settingAnchor`), so settings search and the resolver land on them.
- Commit conventions add **Try a title**: a repository of the scope and a title, checked against the saved conventions by `POST /api/commit-conventions/check`, listing each broken rule as Fails (error) or Unusual (history only).

## Tests

`lib/policy-draft.test.ts`: values at a scope and inheritance, edits, resets and the changes they save, allowlist rows and their rule check. `lib/analyzers-off.test.ts`: the Analyzers off options, reading stored values and the value it writes.
