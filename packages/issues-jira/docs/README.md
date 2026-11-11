# @holtkeeper/issues-jira

A read-only `IssueTracker` ([@holtkeeper/issues](../../issues/docs/README.md)) for Jira Cloud and Jira Data Center / Server. The server builds it from a credential of kind `jira` whose scope covers the repository; without one, nothing calls Jira.

```ts
import { jiraTracker } from '@holtkeeper/issues-jira'

const tracker = jiraTracker({
  url: 'https://widgets.atlassian.net',
  auth: { kind: 'basic', email: 'bot@example.com', token: process.env.JIRA_TOKEN! },
})
const issues = await tracker.issues(['ABC-1', 'ABC-2'])
```

## Public API

- `jiraTracker({ url, auth, flavor?, projects?, fetch? })` — `auth` is `{ kind: 'basic', email, token }` (Cloud API token) or `{ kind: 'bearer', token }` (Data Center personal access token). `flavor` defaults to `cloud` for `*.atlassian.net` and `api.atlassian.com`, `datacenter` otherwise. `projects` (project keys like `ABC`) limits which keys are ever sent; keys of other projects read as unknown.
- `jiraFromCredential(credential, secret, { fetch? })` — the tracker of a stored `jira` credential: `url` is the site, options `{ authKind: 'basic', email }` or `{ authKind: 'bearer' }` with optional `flavor` and `projects`; throws on another kind or invalid options.
- `validateJiraCredentialOptions(kind, options)` — a `CredentialOptionsValidator` for `@holtkeeper/credentials`: `field: message` problems for `jira` credentials, `undefined` for other kinds.
- `JIRA_CREDENTIAL_KIND` (`jira`), `JiraApiError` (`status`).

## Requests

| Flavor      | Search (up to 100 keys)                                                                      | One issue                                |
| ----------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Cloud       | `GET /rest/api/3/search/jql?jql=key in (...)&fields=summary,status,issuetype`                | `GET /rest/api/3/issue/{key}?fields=...` |
| Data Center | `GET /rest/api/2/search?jql=key in (...)&fields=summary,status,issuetype&validateQuery=warn` | `GET /rest/api/2/issue/{key}?fields=...` |

Keys that do not look like Jira keys (`ABC-123`) are never sent, so no text from commits reaches the query. Jira refuses a search naming a key that does not exist with 400; the tracker then asks for each key on its own, five at a time, and leaves out the ones answering 404. Status categories `new`, `indeterminate` and `done` become `todo`, `doing` and `done`; `url` is `<site>/browse/<key>` (none through `api.atlassian.com`). Requests never follow redirects, and errors carry the status but never the credentials.

## Setup

**Cloud.** Create an API token for the account Holtkeeper reads as (a bot account with _Browse projects_ is enough) and store a credential `{ kind: 'jira', url: 'https://<site>.atlassian.net', secret: <token>, options: { authKind: 'basic', email } }`. **Data Center.** Create a personal access token and store `{ kind: 'jira', url: <base URL>, secret: <token>, options: { authKind: 'bearer' } }`. Scope the credential to the groups or repositories whose tickets live in that Jira, and set `options.projects` to their Jira projects: anyone who may read releases of a covered repository sees the title, type and status of every ticket key its release ranges mention.
