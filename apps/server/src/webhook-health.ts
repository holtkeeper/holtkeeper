import type {
  WebhookHealthSummary,
  WebhookHealthView,
  WebhookReenableResult,
} from '@holtkeeper/api'
import type { GitForge, RegisteredHook, RepoRef } from '@holtkeeper/forge'
import type { AuditActor, KvStore, RegisteredWebhook } from '@holtkeeper/store'

import { appendAudit } from './audit.ts'
import type { ServerDeps } from './context.ts'
import { repoHooks } from './repo-hooks.ts'
import { forgetWebhookSeen, listedRepos } from './updates.ts'

const RETRY_BASE_MS = 15 * 60_000
const RETRY_MAX_MS = 24 * 3_600_000
const RATE_LIMITED_WAIT_MS = 60_000
const MIN_ATTEMPT_GAP_MS = 60_000
const DAY_MS = 24 * 3_600_000
const LOCK_TTL_SECONDS = 120
const LOCK_WAIT_MS = 30_000
const LOCK_POLL_MS = 250
const TEST_MARK_TTL_SECONDS = 120

/** A health entry with the repository whose own hook it is and the last re-enable attempt. */
type StoredHookHealth = WebhookHealthView & { repo?: string; attemptedAt?: string }

interface StoredForgeHealth {
  checkedAt: string
  hooks: StoredHookHealth[]
}

interface Candidate {
  forge: string
  owner: 'forge' | 'repo'
  hook: RegisteredWebhook
  repo?: RepoRef
}

const healthKey = (forge: string) => `webhook-health:${forge}`
const lockKey = (forge: string) => `webhook-health-lock:${forge}`
const testMarkKey = (repo: RepoRef) => `webhook-test:${repo.forge}:${repo.path.toLowerCase()}`
const entryKey = (entry: Pick<WebhookHealthView, 'owner' | 'scope' | 'target' | 'hookId'>) =>
  `${entry.owner}:${entry.scope}:${entry.target}:${entry.hookId}`
const repoId = (repo: RepoRef) => `${repo.forge}:${repo.path}`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const rateLimited = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 429
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isStored = (value: unknown): value is StoredForgeHealth =>
  typeof value === 'object' && value !== null && 'hooks' in value && Array.isArray(value.hooks)

const covers = (hook: Pick<RegisteredWebhook, 'scope' | 'target'>, path: string) =>
  hook.scope === 'project' ? hook.target === path : path.startsWith(`${hook.target}/`)

const publicEntry = ({
  repo: _repo,
  attemptedAt: _attemptedAt,
  ...entry
}: StoredHookHealth): WebhookHealthView => entry

/**
 * Whether a re-enable is sending its test delivery to `repo` right now. The webhook receiver
 * ignores pushes to such a repository, so a forge that can only re-enable with a test push (built
 * from real commits) never starts push triggers.
 */
export async function reenableTestRunning(kv: KvStore, repo: RepoRef): Promise<boolean> {
  return (await kv.get(testMarkKey(repo))) !== undefined
}

/** The last health check of `forge`'s hooks; `undefined` before the first. */
async function storedHealth(kv: KvStore, forge: string) {
  const value = await kv.get(healthKey(forge))
  return isStored(value) ? value : undefined
}

/**
 * Holtkeeper's hooks that reach `repo` (its own hook and forge-wide hooks covering it) from the
 * last health check; `undefined` before the first.
 */
export async function webhookHealthOf(
  kv: KvStore,
  repo: RepoRef,
): Promise<WebhookHealthView[] | undefined> {
  const stored = await storedHealth(kv, repo.forge)
  if (!stored) return undefined
  return stored.hooks
    .filter((entry) =>
      entry.owner === 'repo' ? entry.repo === repoId(repo) : covers(entry, repo.path),
    )
    .map(publicEntry)
}

/** Counts of the last health check of `forge`'s hooks; `undefined` before the first. */
export async function webhookHealthSummary(
  kv: KvStore,
  forge: string,
  now: Date,
): Promise<WebhookHealthSummary | undefined> {
  const stored = await storedHealth(kv, forge)
  if (!stored) return undefined
  const count = (match: (entry: StoredHookHealth) => boolean) => stored.hooks.filter(match).length
  return {
    checkedAt: stored.checkedAt,
    total: stored.hooks.length,
    disabled: count((e) => e.state === 'disabled' || e.state === 'temporarily_disabled'),
    missing: count((e) => e.state === 'missing'),
    unknown: count((e) => e.state === 'unknown'),
    reenabled24h: count(
      (e) => e.reenabledAt !== undefined && now.getTime() - Date.parse(e.reenabledAt) < DAY_MS,
    ),
  }
}

/** Which hooks a check looks at, and who asked for it. */
export interface WebhookHealthOptions {
  /** Only this forge's hooks. */
  forge?: string
  /** Only hooks that reach this repository. */
  repo?: RepoRef
  /** Only hooks of these owners; all when absent. */
  owners?: readonly ('forge' | 'repo')[]
  /**
   * Re-enable disabled hooks now, ignoring the wait after a failed attempt, though never twice
   * within a minute.
   */
  force?: boolean
  /** Who re-enables, for the audit log; the system when absent. */
  actor?: AuditActor
}

type HealthDeps = Pick<ServerDeps, 'config' | 'store' | 'vault' | 'now' | 'configSource'>

async function candidatesOf(deps: HealthDeps, options: WebhookHealthOptions) {
  const found: Candidate[] = []
  const owned = (owner: Candidate['owner']) => !options.owners || options.owners.includes(owner)
  const wanted = (forge: string) =>
    (options.forge === undefined || options.forge === forge) &&
    (options.repo === undefined || options.repo.forge === forge)
  for (const doc of owned('forge') ? ((await deps.store.config?.list('forge')) ?? []) : []) {
    if (!wanted(doc.id)) continue
    for (const hook of doc.data.webhook?.registered ?? [])
      if (!options.repo || covers(hook, options.repo.path))
        found.push({ forge: doc.id, owner: 'forge', hook })
  }
  const kv = deps.store.kv
  if (kv && owned('repo')) {
    const hooks = repoHooks(kv, deps.vault)
    const repos = options.repo ? [options.repo] : await listedRepos(kv, deps.config)
    for (const repo of repos) {
      if (!wanted(repo.forge)) continue
      // oxlint-disable-next-line no-await-in-loop
      for (const hook of (await hooks.get(repo))?.registered ?? [])
        found.push({ forge: repo.forge, owner: 'repo', hook, repo })
    }
  }
  return found
}

/**
 * Asks the forge about every hook Holtkeeper registered (forge-wide hooks of panel forges and
 * repository hooks of listed repositories) and re-enables those the forge disabled after failed
 * deliveries. Hooks are matched by id and URL, so other hooks on the same group or project are
 * never touched; when the forge finds a hook under a new id, the stored registration takes it.
 * While a hook is disabled the repositories it reaches forget their last webhook delivery, so
 * polling takes over at once, and while its test delivery runs they ignore pushes
 * (`reenableTestRunning`). Each attempt is audited as `webhook.reenabled`; a failed one waits 15
 * minutes, doubling up to a day, unless `force`; a rate-limited one retries after a minute without
 * counting as failed. Runs of one forge never overlap: a run waits up to 30 seconds for another
 * one and otherwise reports that forge's hooks as last stored. Results are kept per forge and
 * merged into the stored ones by hook, the newer check winning.
 */
export async function checkWebhookHealth(
  deps: HealthDeps,
  options: WebhookHealthOptions = {},
  log: (line: string) => void = () => {},
): Promise<WebhookReenableResult> {
  const result: WebhookReenableResult = { checked: 0, reenabled: 0, failed: 0, hooks: [] }
  if (!deps.store.kv) return result
  const kv: KvStore = deps.store.kv
  const candidates = await candidatesOf(deps, options)
  const listed = options.repo ? [options.repo] : await listedRepos(kv, deps.config)
  const partial =
    options.forge !== undefined || options.repo !== undefined || options.owners !== undefined
  const forges = partial
    ? [...new Set(candidates.map((candidate) => candidate.forge))]
    : Object.keys(deps.config.forges)
  const actor = options.actor ?? { id: 'system', name: 'webhook health', provider: 'system' }
  const holder = crypto.randomUUID()

  for (const forgeId of forges) {
    const own = candidates.filter((candidate) => candidate.forge === forgeId)
    let forge: GitForge | undefined
    try {
      forge = deps.config.forges[forgeId]?.create()
    } catch (error) {
      log(`webhooks: ${forgeId}: ${messageOf(error)}`)
    }
    const statusOf = forge?.webhookStatus?.bind(forge)
    if (!forge || !statusOf) continue
    // oxlint-disable-next-line no-await-in-loop
    if (!(await lock(forgeId))) {
      log(`webhooks: ${forgeId}: another check is running, reporting the last one`)
      // oxlint-disable-next-line no-await-in-loop
      const stored = await storedHealth(kv, forgeId)
      const keys = new Set(own.map((candidate) => entryKey(entryOf(candidate))))
      result.hooks.push(
        ...(stored?.hooks ?? []).filter((entry) => keys.has(entryKey(entry))).map(publicEntry),
      )
      continue
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const previous = await storedHealth(kv, forgeId)
      const before = new Map((previous?.hooks ?? []).map((entry) => [entryKey(entry), entry]))
      const checked: StoredHookHealth[] = []
      const moved = new Set<string>()
      let registrationsChanged = false
      for (const candidate of own) {
        // oxlint-disable-next-line no-await-in-loop
        await kv.acquireLease?.(lockKey(forgeId), holder, LOCK_TTL_SECONDS)
        const oldKey = entryKey(entryOf(candidate))
        // oxlint-disable-next-line no-await-in-loop -- one hook after another keeps rate limits
        const entry = await checkOne(forge, statusOf, candidate, before.get(oldKey))
        if (entryKey(entry) !== oldKey) {
          moved.add(oldKey)
          // oxlint-disable-next-line no-await-in-loop
          if (await persistHookId(candidate, entry.hookId)) registrationsChanged = true
        }
        checked.push(entry)
        result.checked += 1
      }
      if (registrationsChanged) await deps.configSource?.refresh()
      // oxlint-disable-next-line no-await-in-loop
      const current = await storedHealth(kv, forgeId)
      const checkedKeys = new Set(checked.map(entryKey))
      const merged = new Map(
        (current?.hooks ?? [])
          .filter((entry) => !moved.has(entryKey(entry)))
          .filter((entry) => partial || checkedKeys.has(entryKey(entry)))
          .map((entry) => [entryKey(entry), entry]),
      )
      for (const entry of checked) {
        const stored = merged.get(entryKey(entry))
        if (!stored || Date.parse(stored.checkedAt) <= Date.parse(entry.checkedAt))
          merged.set(entryKey(entry), entry)
      }
      // oxlint-disable-next-line no-await-in-loop
      await kv.set(healthKey(forgeId), {
        checkedAt: deps.now().toISOString(),
        hooks: [...merged.values()],
      } satisfies StoredForgeHealth)
      result.hooks.push(...checked.map(publicEntry))
    } finally {
      // oxlint-disable-next-line no-await-in-loop
      await kv.releaseLease?.(lockKey(forgeId), holder)
    }
  }
  if (result.reenabled || result.failed)
    log(`webhooks: ${result.reenabled} re-enabled, ${result.failed} could not be re-enabled`)
  return result

  async function lock(forgeId: string) {
    if (!kv.acquireLease) return true
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const lease = await kv.acquireLease(lockKey(forgeId), holder, LOCK_TTL_SECONDS)
      if (lease.holder === holder) return true
      if (Date.now() >= deadline) return false
      // oxlint-disable-next-line no-await-in-loop
      await sleep(LOCK_POLL_MS)
    }
  }

  function entryOf(candidate: Candidate, hookId = candidate.hook.hookId): StoredHookHealth {
    return {
      owner: candidate.owner,
      scope: candidate.hook.scope,
      target: candidate.hook.target,
      hookId,
      state: 'unknown',
      checkedAt: deps.now().toISOString(),
      ...(candidate.repo && { repo: repoId(candidate.repo) }),
    }
  }

  async function persistHookId(candidate: Candidate, hookId: string) {
    const same = (hook: RegisteredWebhook) =>
      hook.hookId === candidate.hook.hookId &&
      hook.scope === candidate.hook.scope &&
      hook.target === candidate.hook.target
    const renamed = (registered: RegisteredWebhook[]) =>
      registered.map((hook) => (same(hook) ? { ...hook, hookId } : hook))
    if (candidate.repo) {
      const hooks = repoHooks(kv, deps.vault)
      const hook = await hooks.get(candidate.repo)
      if (!hook?.registered?.some(same)) return false
      await hooks.save(candidate.repo, { ...hook, registered: renamed(hook.registered) })
      return false
    }
    const configStore = deps.store.config
    const doc = await configStore?.get('forge', candidate.forge)
    const webhook = doc?.data.webhook
    if (!configStore || !doc || !webhook?.registered?.some(same)) return false
    await configStore.put({
      type: 'forge',
      id: doc.id,
      data: { ...doc.data, webhook: { ...webhook, registered: renamed(webhook.registered) } },
      updatedAt: deps.now().toISOString(),
      updatedBy: 'system',
    })
    return true
  }

  async function checkOne(
    forge: GitForge,
    statusOf: NonNullable<GitForge['webhookStatus']>,
    candidate: Candidate,
    before: StoredHookHealth | undefined,
  ): Promise<StoredHookHealth> {
    const kept = {
      ...(before?.reenabledAt !== undefined && { reenabledAt: before.reenabledAt }),
      ...(before?.attemptedAt !== undefined && { attemptedAt: before.attemptedAt }),
    }
    const { hook } = candidate
    const ref: RegisteredHook = { id: hook.hookId, scope: hook.scope, target: hook.target }
    let status
    try {
      status = await statusOf(ref, hook.url)
    } catch (error) {
      return { ...entryOf(candidate), ...kept, lastError: messageOf(error) }
    }
    const hookId = status.id ?? hook.hookId
    const base = entryOf(candidate, hookId)
    if (status.state === 'enabled' || status.state === 'missing')
      return { ...base, ...kept, state: status.state }

    const disabled: StoredHookHealth = {
      ...base,
      ...kept,
      state: status.state,
      ...(status.disabledUntil !== undefined && { disabledUntil: status.disabledUntil }),
    }
    await forgetReached(candidate)
    if (!forge.enableWebhook) return disabled
    const now = deps.now()
    const waiting = before?.retryAt !== undefined && Date.parse(before.retryAt) > now.getTime()
    const recent =
      before?.attemptedAt !== undefined &&
      now.getTime() - Date.parse(before.attemptedAt) < MIN_ATTEMPT_GAP_MS
    if (recent || (waiting && !options.force))
      return {
        ...disabled,
        ...(before?.failures !== undefined && { failures: before.failures }),
        retryAt:
          before?.retryAt ??
          new Date(Date.parse(before?.attemptedAt ?? '') + MIN_ATTEMPT_GAP_MS).toISOString(),
        ...(before?.lastError !== undefined && { lastError: before.lastError }),
      }

    const label = `${hook.scope} hook ${hook.target} (#${hookId}) on ${candidate.forge}`
    const auditOf = (outcome: 'ok' | 'error', error?: string) =>
      appendAudit(deps.store, {
        at: now.toISOString(),
        actor,
        via: options.actor ? 'ui' : 'system',
        action: 'webhook.reenabled',
        target: {
          type: 'webhook',
          id: hookId,
          ...(candidate.repo
            ? { repo: repoId(candidate.repo) }
            : hook.scope === 'project' && { repo: `${candidate.forge}:${hook.target}` }),
        },
        outcome,
        details: {
          forge: candidate.forge,
          scope: hook.scope,
          target: hook.target,
          state: status.state,
          ...(error !== undefined && { error }),
        },
      })
    const attempted = { attemptedAt: now.toISOString() }
    const reached = reachedBy(candidate)
    try {
      await Promise.all(
        reached.map((repo) => kv.set(testMarkKey(repo), true, TEST_MARK_TTL_SECONDS)),
      )
      await forge.enableWebhook({ ...ref, id: hookId })
      result.reenabled += 1
      log(`webhooks: re-enabled ${label}, the forge had it ${status.state.replace('_', ' ')}`)
      await auditOf('ok')
      return { ...base, state: 'enabled', reenabledAt: now.toISOString(), ...attempted }
    } catch (error) {
      if (rateLimited(error)) {
        log(`webhooks: ${label}: the forge rate-limited the test delivery, retrying soon`)
        return {
          ...disabled,
          ...attempted,
          ...(before?.failures !== undefined && { failures: before.failures }),
          retryAt: new Date(now.getTime() + RATE_LIMITED_WAIT_MS).toISOString(),
          lastError: messageOf(error),
        }
      }
      const failures = (before?.failures ?? 0) + 1
      const wait = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
      result.failed += 1
      log(`webhooks: could not re-enable ${label}: ${messageOf(error)}`)
      await auditOf('error', messageOf(error))
      return {
        ...disabled,
        ...attempted,
        failures,
        retryAt: new Date(now.getTime() + wait).toISOString(),
        lastError: messageOf(error),
      }
    } finally {
      await Promise.all(reached.map((repo) => kv.delete(testMarkKey(repo))))
    }
  }

  function reachedBy(candidate: Candidate): RepoRef[] {
    const { hook } = candidate
    if (candidate.repo) return [candidate.repo]
    if (hook.scope === 'project') return [{ forge: candidate.forge, path: hook.target }]
    return listed.filter((repo) => repo.forge === candidate.forge && covers(hook, repo.path))
  }

  async function forgetReached(candidate: Candidate) {
    await Promise.all(reachedBy(candidate).map((repo) => forgetWebhookSeen(kv, repo)))
  }
}
