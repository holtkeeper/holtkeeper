import { SYSTEM_ACTOR, type Store } from '@holtkeeper/store'

import { llmBudget, type SettingDefinition } from './definitions.ts'

/** A value seeded for every repository on a fresh install. */
export interface DefaultSetting {
  key: string
  value: unknown
}

const presetValue = (definition: SettingDefinition, id: string) =>
  definition.presets?.find((preset) => preset.id === id)?.value

/**
 * Values a fresh install starts with, each for `{ all: true }`: a $150 weekly budget that blocks,
 * 1500 tokens of team knowledge per task, low-risk knowledge auto-accepted and fixes limited to
 * minor upgrades.
 */
export const defaultSettings: DefaultSetting[] = [
  { key: 'llm.budget', value: presetValue(llmBudget, 'default') },
  { key: 'agent.tools', value: { knowledgeTokens: 1500 } },
  { key: 'knowledge.autoAccept', value: ['quirk', 'howto'] },
  { key: 'audit.upgrade', value: 'minor' },
]

/** Key in `Store.kv` marking that defaults were considered; never expires. */
export const DEFAULTS_MARKER = 'settings:defaults-seeded'

export interface SeedDefaultsOptions {
  store: Pick<Store, 'settings' | 'audit' | 'kv'>
  /** Settings the server knows; defaults for other keys, or values they reject, are skipped. */
  definitions: readonly SettingDefinition[]
  defaults?: readonly DefaultSetting[]
  now?: () => Date
}

/**
 * Writes `defaults` for every repository when the store holds no settings at all, once per
 * store: the first call records a marker in `Store.kv` (atomically when it supports
 * `compareAndSet`, so concurrent servers seed once), and later calls do nothing even after every
 * setting was removed. Without `kv` it relies on the store being empty, with stable entry ids so
 * concurrent seeding writes the same entries. Never touches existing entries. Audits the run as
 * `setting.seed` by the system actor. Resolves with the keys written.
 */
export async function seedDefaultSettings({
  store,
  definitions,
  defaults = defaultSettings,
  now = () => new Date(),
}: SeedDefaultsOptions): Promise<string[]> {
  const at = now().toISOString()
  const { kv } = store
  if (kv) {
    if ((await kv.get(DEFAULTS_MARKER)) !== undefined) return []
    if (kv.compareAndSet) {
      if (!(await kv.compareAndSet(DEFAULTS_MARKER, undefined, { at }))) return []
    } else await kv.set(DEFAULTS_MARKER, { at })
  }
  if ((await store.settings.list()).length > 0) return []

  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  const written: string[] = []
  for (const { key, value } of defaults) {
    const definition = byKey.get(key)
    if (!definition || definition.secret) continue
    const parsed = definition.schema.safeParse(value)
    if (!parsed.success) continue
    // oxlint-disable-next-line no-await-in-loop -- a handful of writes, in a stable order
    await store.settings.put({
      id: `default:${key}`,
      key,
      scope: { all: true },
      value: parsed.data,
      secret: false,
      updatedAt: at,
      updatedBy: 'system',
    })
    written.push(key)
  }
  if (written.length > 0)
    await store.audit.append({
      at,
      actor: SYSTEM_ACTOR,
      via: 'system',
      action: 'setting.seed',
      target: { type: 'setting' },
      outcome: 'ok',
      details: { keys: written },
    })
  return written
}
