# @holtkeeper/limits

Limits per credential, so parallel jobs that share one GitLab token or one AI key do not exhaust it. One limiter holds, per key (a credential id): a fair FIFO queue, a semaphore for `maxConcurrent`, token buckets for request and AI-token rates, daily token and cost caps, and a cool-down after a rate-limit answer that every user of the key waits out together.

Wrappers plug it in without touching the clients:

- `limitFetch(fetch, limiter, key, policy)` for forge HTTP clients (one request = one unit);
- `limitAgent(agent, limiter, key, policy)` for `Agent` implementations (one run = one slot, tokens estimated up front and corrected from `result.usage`);
- `limitJobs({ limiter, keysFor })` returns an `admission` hook for the jobs worker, which leaves jobs waiting while their credentials are saturated and runs other jobs meanwhile.

## Policies

```ts
interface LimitPolicy {
  maxConcurrent?: number // leases held at once
  requestsPerMinute?: number // request bucket refill rate
  burst?: number // request bucket size, default requestsPerMinute
  tokensPerMinute?: number // AI tokens (input + output + cache writes)
  tokensPerDay?: number // per UTC day; reaching it denies with LimitExceededError
  costPerDayUsd?: number // per UTC day; reaching it denies with LimitExceededError
  backoff?: { onStatus: number[]; baseMs: number; maxMs: number }
}
```

Omitted fields are unlimited. `limitPolicySchema` validates one policy (strict: unknown fields are rejected). The setting `limitsCredentialsSetting` (`limits.credentials`, section `Runtime`, shaped like `SettingDefinition`) maps credential ids or names to policies.

`resolveLimitPolicy(credential, configured?)` returns the kind defaults overridden field by field by the configured entry for the credential's id, or else its name. Defaults (`defaultLimitPolicy`):

| Kind              | Default                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab`          | `maxConcurrent: 8`, `requestsPerMinute: 300`, back off on 429 (1 s doubling, at most 60 s)                                                              |
| `ai`, `anthropic` | `maxConcurrent: 3`, `tokensPerMinute` from the credential's `options.tokensPerMinute` or `options.limits.tokensPerMinute` when set, back off on 429/529 |
| anything else     | only the 429 backoff                                                                                                                                    |

## Limiter

```ts
import { createLimiter } from '@holtkeeper/limits'

const limiter = createLimiter() // { state?, clock?, pollMs? }
limiter.configure(credential.id, policy)

const lease = await limiter.acquire(credential.id, { requests: 1, tokens: 2000 }, signal)
try {
  // ... work ...
  await lease.release({ tokens: 1800, costUsd: 0.02 })
} catch (error) {
  if (isRateLimit(error)) await lease.throttle({ delayMs: 30_000 })
  await lease.release()
}
```

- **Fair queueing.** Callers of a key are served strictly in arrival order. A head that does not fit yet (bucket empty, no free slot, cool-down) blocks the callers behind it, so a large run is never starved by small requests.
- **Token buckets** refill continuously. A request bigger than the bucket waits until the bucket is full and then drives it negative, so later callers wait for the debt.
- **Token correction.** `release({ tokens })` replaces the estimate: unused tokens go back to the per-minute bucket, extra ones are taken from it, and the daily count uses the actual figure. Without `tokens` the estimate counts.
- **Cool-down.** `throttle({ delayMs })` (or `limiter.throttle(key, hint)`) blocks new leases of the key until then, for every caller. Without a hint the delay is `baseMs` doubling per repeated throttle, reset by a lease released without a throttle; repeated throttles during one cool-down do not double it. Delays are capped at `backoff.maxMs`. `retryDelayFrom(headers, now)` reads `retry-after-ms`, `Retry-After` (seconds or date), and otherwise the latest of `ratelimit-reset`/`x-ratelimit-reset*` (epoch seconds, seconds or durations like `6m0s`) and the exhausted `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset` headers. `throttleHintFrom(error, onStatus, now)` recognizes SDK errors by `status`, `type: 'rate_limit_error'` or the message, and reads their `headers`.
- **Daily caps** deny `acquire` with `LimitExceededError { key, limit, resetsAt }` when `dayTokens + reserved + estimate` would pass `tokensPerDay` or `costPerDayUsd` is used up. Counters reset at UTC midnight.
- **Abort.** `acquire` rejects with the signal's reason when it aborts while queued; the queue moves on.
- **Metrics.** `snapshot()` returns per key `{ inFlight, queued, requestsLeft?, tokensLeft?, coolDownUntil?, last429At?, dayTokens, dayCostUsd }` (times in ISO 8601). `saturated(key)` says whether a new caller would wait or be denied.

### State

Counters live in a `LimiterState`; the default `memoryLimiterState()` keeps them in this process. To share limits between several server processes, implement `LimiterState` on a store (a row per key in Postgres with `SELECT ... FOR UPDATE`, a Redis hash with `WATCH`/`MULTI`, ...):

- `transact(key, change)` runs the synchronous `change` on a copy of the key's `KeyState` (a fresh one for a new key) and stores the result atomically per key across processes; on a write conflict it re-reads and runs `change` again. Nothing is stored when `change` throws.
- `read(key)` and `keys()` serve `snapshot` and `saturated`.
- Queues stay in-process: every process keeps its own FIFO and re-checks the shared counters on local releases, when a computed refill time passes and every `pollMs` (1 s) while waiting for a slot held elsewhere. Fairness is therefore per process; across processes it is approximate.

`storeLimiterState({ kv, prefix?, processId?, ttlSeconds?, staleMs?, heartbeatMs?, clock? })` is the store-backed implementation: one JSON document per key in a key-value store with `get` and `compareAndSet` (`KvStore` from `@holtkeeper/store` on memory, SQLite and Postgres), retried on write conflicts. In-flight slots and token reservations are attributed to the process holding them and refreshed every `heartbeatMs` (30 s) while held; another process gives back the share of one that has not refreshed for `staleMs` (2 min), so a crashed worker does not keep slots forever. Keys untouched for `ttlSeconds` (2 days) expire with their daily counters. `close()` stops the heartbeat. The server selects it with `limits: { distributed: true }`.

## Examples

### One GitLab token shared by 8 games

Eight repositories are analyzed in parallel with the same GitLab token. Wrap the `fetch` the GitLab adapter gets, once per credential, and share the limiter:

```ts
import { createLimiter, limitFetch, resolveLimitPolicy } from '@holtkeeper/limits'

const limiter = createLimiter()
const policy = resolveLimitPolicy(gitlabCredential, settings['limits.credentials'])
// { maxConcurrent: 8, requestsPerMinute: 300, backoff: { onStatus: [429], ... } }

const fetch = limitFetch(globalThis.fetch, limiter, gitlabCredential.id, policy)
const forge = gitlab({ url, token, fetch }) // @holtkeeper/forge-gitlab
```

All jobs using this forge now share 8 concurrent requests and 300 requests per minute. When GitLab answers 429, its `Retry-After`/`RateLimit-Reset` pauses every job using the token, and the request is retried after the pause (up to 3 times, then the 429 is returned to the client, which may retry on its own).

### One corporate AI key shared by review, propagate and port

```ts
import { createLimiter, limitAgent, limitJobs, resolveLimitPolicy } from '@holtkeeper/limits'

// limits.credentials: { "corp-ai": { maxConcurrent: 2, tokensPerMinute: 80000, tokensPerDay: 20000000, costPerDayUsd: 150 } }
const policy = resolveLimitPolicy(aiCredential, settings['limits.credentials'])
const agent = limitAgent(createClaudeAgent(aiCredential), limiter, aiCredential.id, policy)
// the same `agent` instance (or another limitAgent with the same key) serves review, propagate and port
```

- at most two agent runs at once across the three automations;
- each run reserves `ceil((prompt + system + context) / 4)` tokens first (override with `estimateTokens`) and waits while the minute bucket cannot cover it; on success the reservation is replaced by `usage.inputTokens + outputTokens + cacheWriteTokens` and `costUsd` is counted;
- once 20 M tokens or 150 USD are used today, runs fail fast with `LimitExceededError` until UTC midnight;
- a 429/529 from the provider starts a cool-down for all three; the run itself is not retried (it may have changed the checkout), the job's retry handles it.

To keep the worker from tying up its slots with jobs that would only wait for the key, give it the admission hook:

```ts
const admission = limitJobs({
  limiter,
  keysFor: (job) => (['review', 'propagate', 'port'].includes(job.analyzer) ? [aiCredential.id] : []),
})
createJobEngine({ ..., admission })
```

A refused job stays claimed without a concurrency slot (`waiting for capacity` in its log) and is asked again every second; the worker meanwhile claims other jobs, up to `maxWaiting` refused ones.

## Testing

`createManualClock(start?)` returns a clock whose `advance(ms)` fires due timers in order and lets promise chains settle; pass it as `createLimiter({ clock })` (and `now: clock.now` to the wrappers). `settle()` flushes pending promise reactions.
