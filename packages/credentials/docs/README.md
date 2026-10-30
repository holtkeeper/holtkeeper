# @holtkeeper/credentials

Stores forge accounts and API keys, keeps their secrets sealed, and rotates expiring tokens. Provider-specific rotation lives in adapters (for example `gitlabTokenRotator` from `@holtkeeper/forge-gitlab`) behind the `TokenRotator` contract.

## Service

```ts
const credentials = createCredentialService({
  credentials: store.credentials,
  activity: store.activity, // optional
  vault: aesVault(env('HOLTKEEPER_VAULT_KEY')),
  rotators: [gitlabTokenRotator()],
})
```

| Method                     | Does                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `list()`, `get(id)`        | `CredentialView`s: everything except the secret, plus `rotatable` (a rotator handles the kind) |
| `create(input, actor)`     | Validates, seals the secret, fills `expiresAt` from the rotator's `inspect` if not given       |
| `update(id, input, actor)` | Changes given fields; a new secret is sealed, re-inspected and clears `lastError`              |
| `remove(id, actor)`        | Deletes                                                                                        |
| `reveal(id)`               | The plaintext secret, for internal callers that use the credential; never send it out          |
| `rotate(id, actor)`        | Rotates now (see below)                                                                        |
| `rotateDue()`              | Rotates every credential that is due; returns `{ id, ok, error? }[]`                           |

Input that fails validation throws `CredentialInputError` with one `field: message` entry per problem; an unknown id throws `CredentialNotFoundError`. Validation requires a non-empty `name`, `kind` and `secret`, an http(s) `url`, a valid `Scope`, an ISO 8601 `expiresAt`, and a rotation policy with positive integer `daysBefore` < `lifetimeDays` (otherwise a fresh token would be due again at once).

Every change appends an activity event — `credential.created`, `credential.updated` (with the changed field names), `credential.removed`, `credential.rotated`, `credential.rotation_failed` — with the acting principal id, or `system` for scheduled rotations. Events and errors never contain secrets.

## Options

A credential may carry `options`: kind-specific configuration that is not secret, such as an AI provider's endpoint, headers and model map. They are returned in views and stored unsealed, so never put a secret there; header values can reference the credential's secret as `{secret}` instead (see [@holtkeeper/agent](../../agent/docs/README.md#providers)).

- Validation: a JSON object of at most `MAX_OPTIONS_BYTES` (16 KiB) serialized.
- `update` with `options` replaces them as a whole; `options: {}` removes them. `create` with `{}` stores none.
- `createCredentialService({ ..., validateOptions })` adds kind-specific checks: `validateOptions(kind, options)` returns `field: message` problems (thrown as `CredentialInputError`), `[]` when fine, or `undefined` for kinds it does not know. It runs on `create` and on every `update` that changes `kind` or `options`. `aiProviderOptionsValidator` from `@holtkeeper/agent` validates the AI provider kinds.

```ts
await credentials.create(
  {
    name: 'Corp gateway',
    kind: 'anthropic-compatible',
    url: 'https://llm.corp.example/anthropic',
    scope: { all: true },
    secret: 'gateway-token',
    options: { authHeader: 'bearer', headers: { 'X-Team': 'platform' } },
  },
  actor,
)
```

## Rotation lifecycle

```ts
interface TokenRotator {
  readonly kind: string
  rotate(input: {
    url
    token
    lifetimeDays
    signal?
  }): Promise<{ token: string; expiresAt: string }>
  inspect?(input: { url; token; signal? }): Promise<{ expiresAt?; name?; scopes? }>
}
```

`rotate(id, actor)`:

1. Picks the rotator for the credential's `kind`. Without one it throws `CredentialInputError` and leaves the credential (secret, `lastError`) untouched.
2. Opens the sealed secret and asks the rotator for a new token valid for `rotation.lifetimeDays` (90 when the credential has no policy).
3. Seals the new token and stores it together with the new `expiresAt`, `lastRotatedAt`, and a cleared `lastError`.
4. On any failure stores `lastError`, logs `credential.rotation_failed` and rethrows.

Concurrent `rotate` calls for the same credential share one rotation.

A credential is **due** when a rotator handles its kind, `rotation.enabled` is set and `expiresAt` is within `daysBefore` days or already past. Credentials without `expiresAt` are never due; give one or use a kind whose rotator can `inspect`.

## Scheduling

```ts
const stop = startRotationSchedule(credentials, {
  intervalMs: 3_600_000, // default: hourly
  onResults: (results) => log(results),
  onError: (error) => log(error),
})
```

Runs `rotateDue()` immediately and then every `intervalMs`, skipping a tick while the previous run is still going. Nothing thrown inside escapes the timer. Run one schedule per store: two processes rotating the same token race each other (see below).

## Security notes

- **Rotation invalidates the old token immediately.** The new token is stored before anything else can use it, but any process still holding the old plaintext (a running job, another server instance) fails from then on. Callers should `reveal` the secret right before use rather than caching it.
- If the provider rotated but storing the new token failed, the token is lost: `lastError` says so and the credential must be re-entered by hand.
- Reusing a revoked token for rotation can make the provider revoke the whole token family (GitLab does). Never rotate the same credential from two places.
- Secrets are sealed by the `Vault` before they reach the store; views, activity and errors never carry them. `reveal` is for in-process use only.
