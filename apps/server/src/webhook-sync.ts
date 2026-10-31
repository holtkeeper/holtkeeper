import { type WebhookTarget, webhookEvents } from '@holtkeeper/forge'
import type { RegisteredWebhook } from '@holtkeeper/store'

import type { ServerDeps } from './context.ts'
import { repoHooks } from './repo-hooks.ts'
import { listedRepos } from './updates.ts'

const SYNC_INTERVAL_MS = 3_600_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Whether a registered hook lacks some of the events Holtkeeper registers now. */
const outdatedHook = (hook: RegisteredWebhook): boolean =>
  webhookEvents.some((event) => !hook.events?.includes(event))

const targetOf = (hook: RegisteredWebhook): WebhookTarget =>
  hook.scope === 'group' ? { group: hook.target } : { project: hook.target }

/**
 * Re-registers hooks Holtkeeper registered earlier whose events are not the current
 * `webhookEvents`, keeping their URL and secret, so hooks registered before a new event kind
 * existed start delivering it. Covers panel forge webhooks and repository webhooks of the
 * repositories polling has listed. Failures are logged and retried on the next run.
 */
export async function syncWebhooks(
  deps: Pick<ServerDeps, 'config' | 'store' | 'vault' | 'now' | 'configSource'>,
  log: (line: string) => void = () => {},
): Promise<{ updated: number; failed: number }> {
  let updated = 0
  let failed = 0
  const events = [...webhookEvents]

  const ensure = async (forgeId: string, hook: RegisteredWebhook, secret: string) => {
    const forge = deps.config.forges[forgeId]?.create()
    if (!forge?.ensureWebhook) throw new Error(`forge ${forgeId} cannot register webhooks`)
    await forge.ensureWebhook(targetOf(hook), { url: hook.url, secret, events })
    return { ...hook, events }
  }

  const refresh = async (
    forgeId: string,
    hooks: RegisteredWebhook[],
    secret: () => Promise<string>,
  ): Promise<RegisteredWebhook[] | undefined> => {
    if (!hooks.some(outdatedHook)) return undefined
    const opened = await secret()
    const next: RegisteredWebhook[] = []
    for (const hook of hooks) {
      if (!outdatedHook(hook)) {
        next.push(hook)
        continue
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one hook after another keeps rate limits
        next.push(await ensure(forgeId, hook, opened))
        updated += 1
      } catch (error) {
        failed += 1
        next.push(hook)
        log(`webhooks: ${forgeId} ${hook.scope} ${hook.target}: ${messageOf(error)}`)
      }
    }
    return next
  }

  const configStore = deps.store.config
  if (configStore) {
    let changed = false
    for (const doc of await configStore.list('forge')) {
      const webhook = doc.data.webhook
      if (!webhook?.registered?.length) continue
      // oxlint-disable-next-line no-await-in-loop
      const registered = await refresh(doc.id, webhook.registered, () =>
        deps.vault.open(webhook.secret),
      )
      if (!registered) continue
      // oxlint-disable-next-line no-await-in-loop
      await configStore.put({
        type: 'forge',
        id: doc.id,
        data: { ...doc.data, webhook: { ...webhook, registered } },
        updatedAt: deps.now().toISOString(),
        updatedBy: 'system',
      })
      changed = true
    }
    if (changed) await deps.configSource?.refresh()
  }

  const kv = deps.store.kv
  if (kv) {
    const hooks = repoHooks(kv, deps.vault)
    for (const repo of await listedRepos(kv, deps.config)) {
      // oxlint-disable-next-line no-await-in-loop
      const hook = await hooks.get(repo)
      if (!hook?.registered?.length) continue
      // oxlint-disable-next-line no-await-in-loop
      const registered = await refresh(repo.forge, hook.registered, () => hooks.token(hook))
      // oxlint-disable-next-line no-await-in-loop
      if (registered) await hooks.save(repo, { ...((await hooks.get(repo)) ?? hook), registered })
    }
  }

  if (updated || failed) log(`webhooks: ${updated} updated to every event, ${failed} failed`)
  return { updated, failed }
}

/** Runs `syncWebhooks` now and every hour until the returned function is called; a leader duty. */
export function startWebhookSync(
  deps: Parameters<typeof syncWebhooks>[0],
  log: (line: string) => void,
) {
  let running: Promise<unknown> | undefined
  const run = () => {
    running ??= syncWebhooks(deps, log)
      .catch((error: unknown) => log(`webhooks: ${messageOf(error)}`))
      .finally(() => {
        running = undefined
      })
  }
  const timer = setInterval(run, SYNC_INTERVAL_MS)
  run()
  return async () => {
    clearInterval(timer)
    await running
  }
}
