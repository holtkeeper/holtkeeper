# @holtkeeper/web-paths

Paths of the web panel's pages, for everything outside `apps/web` that links into the panel: Home's Needs attention items, Inbox items, chat cards, merge request comments, analysis reports, MCP tool answers and config warnings. It has no dependencies, so any package can use it.

```ts
import { webPaths, webUrl } from '@holtkeeper/web-paths'

webPaths.runs({ status: 'failed', analyzer: 'widgets' }) // '/ops/runs?status=failed&analyzer=widgets'
webPaths.releaseTimeline('gitlab:acme/widget-kit') // '/releases/timeline?repo=gitlab%3Aacme%2Fwidget-kit'
webPaths.repo('gitlab:acme/widget-kit', { tab: 'quality', section: 'assets' }) // '/repos/gitlab/acme/widget-kit?tab=quality&section=assets'
webUrl('https://hk.acme.dev/', webPaths.tasks({ group: 'g-1', task: 't-2' })) // 'https://hk.acme.dev/ops/tasks?group=g-1&task=t-2'
```

## Guarantees

- Every path starts with `/` and is relative to the panel's origin; `webUrl(publicUrl, path)` makes it absolute, ignoring trailing slashes of `publicUrl`.
- Search parameters that are `undefined` or empty are left out; values are URL-encoded. Repository keys are `forge:path`.
- Single path segments (ids) are encoded whole.
- `repo` puts the `forge:path` key in the path, `/repos/<forge>/<path>`, encoding each segment on its own. `tab` is one of `overview`, `supply`, `quality`, `releases`, `activity`, `knowledge`, `settings`; `section` names an area of the tab (`assets` on Quality, `updates` on Settings).
- `knowledge` takes the tab (`guide`, `notes`, `learnings`) and what to open in it: `space` is a Guide scope key (`all`, `group:<g>`, `family:<id>`, `repo:<forge>:<path>`), `section` a Guide section, `note` a note id.
- `tasks` drops `task` without `group`, as the Tasks page only selects a task inside its group.

## Paths

| Builder                                                                       | Path                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `inbox({ item?, kind?, tab? })`                                               | `/inbox?item=&kind=&tab=` (`tab`: `snoozed`)                             |
| `repos()`                                                                     | `/repos`                                                                 |
| `repo(repo, { tab?, section?, file?, ref? })`                                 | `/repos/<forge>/<path>?tab=&section=&file=&ref=` (hub)                   |
| `groups()`                                                                    | `/repos/groups`                                                          |
| `security()`                                                                  | `/supply/security`                                                       |
| `securityRun(runId)`                                                          | `/supply/security/runs/<runId>`                                          |
| `releaseTimeline(repo)`                                                       | `/releases/timeline?repo=`                                               |
| `knowledge(tab, { space?, section?, note? })`                                 | `/knowledge/guide\|notes\|learnings?space=&section=&note=`               |
| `chat(thread?)`                                                               | `/chat?thread=`                                                          |
| `runs({ repo?, status?, analyzer?, trigger?, schedule?, signature?, view? })` | `/ops/runs`                                                              |
| `tasks({ group?, task?, filter? })`                                           | `/ops/tasks`                                                             |
| `automation(job?)`                                                            | `/ops/automation?job=`                                                   |
| `settings(section)`                                                           | `/settings/people\|ai\|integrations\|analyzers\|policies\|system\|audit` |

Builders exist only for pages something outside `apps/web` links to; a module that starts linking to another page adds its builder here. The web app's router must serve each of these paths. A renamed page changes its builder here, and links already posted (merge request comments, reports) stop working: there are no redirects.
