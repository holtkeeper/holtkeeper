import type { SettingPresetView } from '@holtkeeper/api'

import { applyPreset, matchingPreset } from '../../lib/presets.ts'
import { Select } from '../../ui/index.ts'

/** Picks one of a setting's presets and hands the value it produces to `onApply`. */
export function PresetPicker({
  presets,
  value,
  onApply,
}: {
  presets: readonly SettingPresetView[]
  value: unknown
  onApply: (value: unknown) => void
}) {
  const current = matchingPreset(value, presets)
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        label="Preset"
        placeholder="Start from a preset…"
        options={presets.map((preset) => ({ id: preset.id, label: preset.label }))}
        value={current?.id}
        onChange={(id) => {
          const preset = presets.find((candidate) => candidate.id === id)
          if (preset) onApply(applyPreset(value, preset))
        }}
      />
      <span className="text-xs text-muted">
        {current?.description ??
          'Applying a preset fills in its fields and keeps the rest; edit the result before saving.'}
      </span>
    </div>
  )
}
