import type { SettingPresetView } from '@holtkeeper/api'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The value after applying `preset` to `current`: for objects the preset's fields over the current
 * ones, anything else replaced by the preset's value.
 */
export function applyPreset(current: unknown, preset: SettingPresetView): unknown {
  return isRecord(current) && isRecord(preset.value)
    ? { ...current, ...preset.value }
    : structuredClone(preset.value)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The preset `value` already matches, field by field for objects; `undefined` when none does. */
export function matchingPreset(
  value: unknown,
  presets: readonly SettingPresetView[],
): SettingPresetView | undefined {
  return presets.find((preset) =>
    isRecord(value) && isRecord(preset.value)
      ? Object.entries(preset.value).every(([key, field]) => same(value[key], field))
      : same(value, preset.value),
  )
}
