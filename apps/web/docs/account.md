# Account

Part of the web app's [Account](README.md#account) docs.

Route `/account/$section`, page `features/account/AccountPage.tsx`, sections in `lib/account-sections.ts`. A bare `/account` (the avatar target) redirects to `/account/profile`.

## My access

`features/account/MyAccess.tsx`: the viewer's role (`roleLabel` from `lib/access.ts`: the People preset from `roleOf` in `lib/roles.ts`, so Account, the header tag and the Forbidden card say _Developer_ or _Maintainer_ where People does, and _Custom_ for grants matching no preset) and every grant with where it applies and what it allows. With the `users` provider, a **Given by** row names the person who invited the viewer and when, from `UserView.creator` of `GET /auth/users/me`; when nobody did (the CLI, the bootstrap admin, a removed user) there is no row.

## Connect agents

`features/mcp/McpServer.tsx`, one flow: steps in a flush row, **Your tokens** (a status `Strip`, a name filter and the table), **Client setup** (endpoint plus Claude Code, Cursor, `.mcp.json` and curl tabs with Copy) and **Tool reference** (live `tools/list`). **New token** is the header's primary action on this section; `AccountPage` keeps the dialog state and hands it to the body. Everyone's usage is not shown here; per-token and per-person counters are deferred, so tokens show only their last use.
