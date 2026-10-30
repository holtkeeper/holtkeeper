# @holtkeeper/confluence

Confluence as a `DocumentSource` (read a page) and a `DocumentSink` (replace one marked section of a page) for `@holtkeeper/tracker`. Speaks Confluence Cloud REST v2 and Data Center / Server REST v1.

```ts
import { confluence } from '@holtkeeper/confluence'
import { env } from '@holtkeeper/forge'

const { source, sink } = confluence({
  url: 'https://acme.atlassian.net',
  auth: { kind: 'basic', email: 'bot@acme.com', token: env('CONFLUENCE_TOKEN') },
})

const page = await source.read(
  'https://acme.atlassian.net/wiki/spaces/ENG/pages/123456/Dependencies',
)
await sink.replaceSection(page.ref, {
  markerId: 'deps',
  content: '## Outdated\n\n| Package | Version |\n| - | - |\n| zod | 3.0 |',
  format: 'markdown',
  expectedVersion: page.version,
  message: 'holtkeeper: dependency report',
})
```

## Options

| Option    | Meaning                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | Cloud: `https://<site>.atlassian.net` (with or without `/wiki`) or the gateway `https://api.atlassian.com/ex/confluence/<cloudId>`. Data Center: the base URL with its context path, e.g. `https://wiki.example.com/confluence` |
| `auth`    | `{ kind: 'basic', email, token }` (Cloud API token) or `{ kind: 'bearer', token }` (Data Center personal access token). `token` is a `Secret`, resolved on the first request                                                    |
| `flavor`  | `cloud` or `datacenter`; default `cloud` for `*.atlassian.net` and `api.atlassian.com`, `datacenter` otherwise                                                                                                                  |
| `fetch`   | Injected `fetch` (tests)                                                                                                                                                                                                        |
| `retries` | How often a `429` is retried after `Retry-After` (capped at 60 s); default 1                                                                                                                                                    |

Both `source` and `sink` have `provider: 'confluence'`. Requests never follow redirects (the `Authorization` header would travel with them), and error messages carry the status and Confluence's own message with the token and the Basic credentials redacted.

## Setup

**Cloud.** Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> for the account holtkeeper acts as (a dedicated bot account is best) and configure `{ kind: 'basic', email, token }`. A scoped token needs `read:page:confluence` and `write:page:confluence`; scoped tokens only work through `https://api.atlassian.com/ex/confluence/<cloudId>` (find the cloud id at `https://<site>.atlassian.net/_edge/tenant_info`).

**Data Center / Server (7.9+).** Create a personal access token under _Profile → Personal Access Tokens_ and configure `{ kind: 'bearer', token }`.

**Permissions.** The account needs _View_ on the space for `read`, and _Add / Edit pages_ on the space for `replaceSection`; page restrictions, if any, must allow it to view and edit the page.

## References

`ref` is a page id (`123456`) or a page link: anything with `/pages/<id>` in its path (Cloud `…/spaces/KEY/pages/123456/Title`, `…/pages/edit-v2/123456`) or a `pageId` query parameter (Data Center `…/pages/viewpage.action?pageId=123456`). Links must be on the configured host (any host when going through `api.atlassian.com`). Tiny links (`/x/AbC`) and `/display/KEY/Title` links are not resolved. `read` returns the ref it was given.

## Requests

| Call             | Cloud (v2)                                                                                                                                                                          | Data Center (v1)                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `read`           | `GET /wiki/api/v2/pages/{id}?body-format=storage`                                                                                                                                   | `GET /rest/api/content/{id}?expand=body.storage,version`                                                                   |
| `replaceSection` | the read above, then `PUT /wiki/api/v2/pages/{id}` with `id`, `status: current`, `title`, `body: { representation: 'storage', value }`, `version: { number: current + 1, message }` | the read above, then `PUT /rest/api/content/{id}` with `id`, `type`, `title`, `status: current`, `body.storage`, `version` |

`read` always returns `format: 'storage'`. The page title is kept; pages that are not `current` (drafts, trashed) are refused rather than restored.

## Sections and markers

A section is the storage XHTML between two **anchor macros** whose anchor names are `holtkeeper:<markerId>:start` and `holtkeeper:<markerId>:end` (an id already starting with `holtkeeper:` is not prefixed twice). This package writes each marker as a paragraph of its own:

```xml
<p>Hand-written introduction stays as it is.</p>
<p><ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">holtkeeper:deps:start</ac:parameter></ac:structured-macro></p>
<h2>Outdated</h2>
<table><tbody><tr><th>Package</th><th>Version</th></tr><tr><td>zod</td><td>3.0</td></tr></tbody></table>
<p><ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">holtkeeper:deps:end</ac:parameter></ac:structured-macro></p>
<p>Notes below the section stay too.</p>
```

Anchors were chosen because they are invisible when the page is viewed, round-trip through both the Cloud and the legacy editor (the editor may add `ac:macro-id`, `local-id` and whitespace — matching ignores those), and do not wrap the content, so editors can format the generated part freely without breaking a container macro.

- **Present:** everything between the end of the start marker's paragraph and the start of the end marker's paragraph is replaced. Everything outside, the markers included, is kept byte for byte.
- **Missing:** both markers and the content are appended at the end of the page.
- **Broken** (only one marker, duplicates, end before start, or markers moved into different blocks such as a table cell): `MarkerError`, nothing is written.
- **Empty `markerId`:** the whole page body is replaced.
- **Unchanged:** when the new content equals the current section after normalization (collapsed whitespace, editor ids, `&nbsp;` spellings, self-closing spacing, empty paragraphs), no `PUT` is sent and the result has `changed: false` and the current version.

**For page editors.** In the editor the markers show as two small anchor icons. Write above the start anchor or below the end anchor; anything between them is overwritten on the next run. Do not delete, rename, duplicate or move the anchors into a table or list. To retire a section, delete both anchors and the content between them — holtkeeper then appends a fresh section at the end on its next run, so also remove it from the tracker. To move a section, cut both anchors together with everything between them.

## Content formats

- `storage` — used as is; must be balanced XHTML.
- `markdown` — converted to storage: ATX headings, paragraphs, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links (http(s), mailto and relative only; others become plain text), autolinks, nested `-`/`1.` lists, GFM tables with alignment, block quotes, `---`, hard line breaks, and fenced code as the `code` macro (`language` parameter, CDATA body with `]]>` split). All text is escaped; raw HTML in Markdown is shown as text.
- `html` — sanitized to the storage subset: headings, `p`, `strong`/`b`, `em`/`i`, `u`, `s`/`del`, `sub`, `sup`, `code`, `pre`, `blockquote`, `a[href]`, lists, tables (`colspan`/`rowspan` kept), `br`, `hr`. `script`, `style`, `iframe` and similar are dropped with their content, other elements are unwrapped, other attributes are removed, and missing end tags are added.

## Versions

With `expectedVersion`, a page at another version rejects with `VersionConflictError` (`code: 'version_conflict'`, `expected`/`actual`, also `expectedVersion`/`actualVersion`) before anything is written. A concurrent edit between the read and the `PUT` (Confluence answers `409`) is reported the same way after re-reading the version; a `409` without a version change (Cloud content approval) stays a `ConfluenceApiError`.

## Credentials

Kind `confluence` for `@holtkeeper/credentials`: `url` is the site URL, the secret is the API token or PAT, and `options` are `{ authKind: 'basic', email, flavor? }` or `{ authKind: 'bearer', flavor? }`.

```ts
import { confluenceFromCredential, validateConfluenceCredentialOptions } from '@holtkeeper/confluence'

createCredentialService({ ..., validateOptions: validateConfluenceCredentialOptions })
const { source, sink } = confluenceFromCredential(view, await credentials.reveal(view.id))
```

`validateConfluenceCredentialOptions(kind, options)` returns `field: message` problems (`undefined` for other kinds). `confluenceFromCredential(credential, secret, { fetch?, retries? })` throws on another kind or invalid options.

## Public API

`confluence`, `detectFlavor`, `confluenceFromCredential`, `validateConfluenceCredentialOptions`, `confluenceCredentialOptionsSchema`, `CONFLUENCE_CREDENTIAL_KIND`; the pure helpers `markdownToStorage`, `sanitizeHtml`, `replaceSectionInStorage`, `findSection`, `normalizeStorage`, `renderMarker`, `markerName`, `parsePageRef`; errors `ConfluenceApiError` (`status`), `VersionConflictError`, `MarkerError`, `ConfluenceInputError`; and the `DocumentSource`/`DocumentSink` types, structurally identical to those of `@holtkeeper/tracker`.
