# Command palette (⌘K)

The palette searches everything the signed-in person can open and runs a few actions. It lives in `features/shell/CommandPalette.tsx`; ranking, grouping, filters and recent items are pure functions in `lib/palette.ts` with tests next to them.

## Opening

- **⌘K** or **Ctrl+K** anywhere in the signed-in app toggles it. `AppShell` listens on `window` and mounts the palette once, so it works on every page, including inside text fields.
- The rail's **⌘K** button and the **Search** button on the not-found page call `openPalette()` from `features/shell/palette.ts`. That module holds the open state (`setPaletteOpen`, `usePaletteOpen`); outside the shell nothing is mounted and `openPalette` does nothing.
- **Esc**, a click outside or opening a result closes it. The query starts empty each time.

## Sources

Data is fetched only while the palette is open, and only what the principal may read:

| Group                 | Source                                                                                                    | Shown when                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Repositories          | `GET /api/repos`, with each repository's health and health cells                                          | `repos:read`                               |
| Libraries and symbols | `GET /api/dependencies/search?q=&limit=10`, and `GET /api/api-surface/search?q=` (two characters or more) | catalog reach (`canCatalog`) and a query   |
| Pages                 | `visibleNav` without the Settings sections (`paletteNav`), titled `Workspace › Page`                      | always                                     |
| Settings              | `settingsIndex` from `lib/settings-search.ts`, the same index as the Settings search field                | sections from `visibleSettingsSections`    |
| Actions               | switch theme, open the documentation, new chat thread (when Chat is visible), sign out (`auth.logoutUrl`) | always                                     |
| People                | `GET /auth/users/admin/users`, opening the person on Settings › People (`?item=<userId>`)                 | `users:read` and the `users` auth provider |
| Recent                | pages opened from the palette, kept in `localStorage` per principal                                       | while the viewer can still reach them      |

Remote queries are debounced by 150 ms. A repository result shows its overall tone (Failing, Warnings, Healthy, Not analysed, from `RepoSummary.health`) with the cells that need attention in its subtitle and, while selected, a preview with its groups, forge, the health cells it may read and links to the repository page's tabs the principal can see.

## Matching and ranking

`parseQuery` reads a leading `>` as actions, `#` as repositories and `@` as people; otherwise the chip decides the kind. `scoreItem` ranks a title prefix first, then a word of the title starting with the query (words split on spaces, `/`, `.`, `:`, `›`, `@`, `_`, `-`), then a substring of the title, then every word found in the title, subtitle or hidden keywords; ties keep the source order. `highlight` marks the first match in the title.

`buildResults(sources, query, filter)` returns the groups, the per-kind match counts for the chips and the flat list ↑ ↓ move through:

- With **All**, each group keeps its best 5 and recent items already shown in their own group are dropped from Recent. Without a query, All shows Recent first, then Pages and Actions.
- With one kind, that group keeps up to 50.

## Keyboard

↑ and ↓ move the selection (wrapping, `moveSelection`), ↵ opens it, Esc closes. Results that are pages are real links, so ⌘-click or a middle click opens them in a new tab. The input is a combobox whose `aria-activedescendant` points at the selected option.

## Recent items

`recordRecent(storage, principal, item)` puts an opened page first, at most 8, without duplicates; actions are never recorded. `readRecent(storage, principal)` drops anything that does not look like a recent item (an unknown kind, a link that is not an in-app path). Both take the storage as an argument and catch every error, so a private window, blocked storage or a missing `localStorage` leaves the palette working with an in-memory list. The key is `holtkeeper.palette.recent:<principal id>`, so people sharing a browser never see each other's items, and sign-out (`useAuthMutations().logout`) removes every such key with `clearRecent`. `recentItems(recent, ago, available, libraries)` shows only items still among the current results of their kind (a repository still in `/api/repos`, a page still visible, a person still listed) and libraries only with catalog reach.
