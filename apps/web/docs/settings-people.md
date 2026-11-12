# Settings › People & access

Part of the web app's [Settings](README.md#settings) docs.

Route `/settings/people`, body `features/settings/sections/PeopleSection.tsx`, endpoints and hooks in `api/settings-people.ts`.

## Users

`features/users/People.tsx`, shown with `users:read` and the `users` auth provider only.

- **Strip** — `GET /auth/users/admin/summary` (`usePeopleSummary`): people, active, invited, disabled, admins, without a passkey or SSO, and the sign-in methods on offer.
- **Toolbar** — search (name, email, team), Role, Team, Sign-in and Status filters (`PeopleFilter`, `matchesPeople` in `lib/people.ts`; Status starts at Active and Invited), "x of y shown", and a Table | Access map switch. **Invite people** (`users:invite`) is the section header's primary action. Disabled people fold into a footer button that adds them to the Status filter.
- **Table** — person (avatar, name, email, `you`), teams (`UserView.teams`: home groups, else the groups in the grants), role, applies to (the preset's scope, else the number of grants), last seen (`UserView.lastSeenAt`), sign-in (`signInLabel`), status with the invite note ("Link expires in 2 days", "Link expired · send a new one"). A row opens the person's sheet; the open person and its tab live in the URL as `?item=<userId>&tab=` (Role is the default tab), so ⌘K and links can open a person directly.
- **Access map** — `AccessMap.tsx` over the filtered people (`lib/access-map.ts`); clicking a person opens their sheet.
- **Invite** — `InviteDialog.tsx`: name, email, a role preset with its scope (Admin always covers everything), or exact grants. The one-time link is shown once in `LinkDialog`.

### UserSheet

`features/users/UserSheet.tsx`, a `SideSheet` with J/K through the shown rows. The header shows status, role, teams, "Added … by …" (`UserView.creator`) and the invite note. Quiet actions: **Send a new invite** (`POST /auth/users/admin/users/:id/invite`, `useResendInvite`, with `users:invite`) while the person never signed in, otherwise **Create recovery link** (`users:write`), and **Disable**/**Enable** (never on yourself). The ⋯ menu edits name and email.

- **Role and access** — the preset picker (`RolePicker.tsx`) marks the current role and the new one, then Applies to (`ScopeEditor`), "What … can do" (`abilityChanges`: Allowed, Gains, Loses, Not allowed), and the raw grants with **Edit exact grants** (`GrantsEditor`). Save writes `PATCH /auth/users/admin/users/:id { grants }`; nothing is written until Save, and grants that match no preset show as Custom and stay untouched unless a preset is picked or the grants are edited. Your own access is read-only here.
- **Sign-in** — passkeys (remove with `users:write`) and linked single sign-on identities.
- **Teams** — `UserView.teams`; teams only drive "My teams", never access.
- **Activity** — last seen, then what the person did from `GET /api/history?actor=<id>` (`useHistory`), so it follows the Audit log's visibility: a global `audit:read` sees everything, `repos:read` only the events of repositories the viewer reads.

## Roles

`lib/roles.ts`: four presets (Viewer, Developer, Maintainer, Admin), each one grant with the preset's actions on one scope, Admin `*` on everything. `roleOf(grants)` returns the preset and the union of the grants' scopes only when every grant carries exactly a preset's actions (Admin: a single `*` grant on everything); anything else is `custom`, `none` without grants. `grantsForRole(role, scope)` builds the grants a picked preset saves. The Roles block shows each preset with how many enabled people hold it.

## Reach

`access.crossTeam`, one level for every person, team and agent, with no per-team exceptions. The radio list (`reachLevels` in `lib/people.ts`) says what each level really opens: Own teams only, Catalog of every team (packages, public API, stack, usage counts, shared notes; no code) and Catalog and usage code of every team. The current level comes from `/api/me`; changing it needs a global `settings:write` and writes the org entry through `PUT /api/settings`.

## Read-only repositories

The `repo.freeze` entries with their own editor (`SettingEntries`). The most specific entry wins: an entry with **frozen** off lifts a broader freeze for its scope, e.g. one repository of a frozen group. A new entry starts frozen with an empty reason, so the reason field and the **frozen** switch show at once; turning the switch off makes it a lift, where the reason may stay empty. Anyone with `settings:write` on a group or repository can lift a broader freeze there, one set for everything included.
