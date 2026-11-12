import { type RoleId, type RolePresetId, rolePresetIds, rolePresets } from '../../lib/roles.ts'

/** The four presets as a radio list; `current` marks the person's role before any change. */
export function RolePicker({
  value,
  current,
  onChange,
  label,
  isDisabled,
}: {
  value: RoleId
  current?: RoleId
  onChange: (role: RolePresetId) => void
  label: string
  isDisabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      {rolePresetIds.map((id) => {
        const preset = rolePresets[id]
        const selected = value === id
        const note = current === id ? 'Current' : selected && current !== undefined ? 'New' : ''
        return (
          <label
            key={id}
            aria-label={preset.label}
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus ${
              selected ? 'border-line-strong bg-raise' : 'border-line hover:bg-raise'
            } ${isDisabled ? 'pointer-events-none opacity-60' : ''}`}
          >
            <input
              type="radio"
              name={label}
              className="mt-0.5 accent-[var(--brand)]"
              checked={selected}
              disabled={isDisabled}
              onChange={() => onChange(id)}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <b className="font-medium">{preset.label}</b>
                {note ? <span className="text-[11.5px] text-dim">{note}</span> : null}
              </span>
              <span className="text-xs text-muted">{preset.summary}</span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
