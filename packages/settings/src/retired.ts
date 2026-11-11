/**
 * Setting keys Holtkeeper no longer reads. Stored entries under them stay in the store until a
 * cleanup removes them, but the resolver never returns them, the API never lists them and the
 * server refuses new values for them, so old rows never fail validation.
 */
export const retiredSettingKeys: ReadonlySet<string> = new Set([
  'llm.model',
  'llm.models',
  'review.instructions',
  'agent.instructions',
  'analyzers.changelog',
  'analyzers.delivery',
  'analyzers.fleet',
  'analyzers.port',
  'analyzers.quality',
  'analyzers.release-risk',
  'analyzers.warmup',
])

/** Whether `key` is in `retiredSettingKeys`. */
export const isRetiredSetting = (key: string): boolean => retiredSettingKeys.has(key)
