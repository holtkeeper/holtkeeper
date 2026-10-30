import { ToggleButton, ToggleButtonGroup } from '@heroui/react'
import type { Key, ReactNode } from 'react'

/** Exactly one of a few options, shown as connected buttons. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  size = 'sm',
}: {
  options: readonly { id: T; label: ReactNode }[]
  value: T
  onChange: (value: T) => void
  'aria-label': string
  size?: 'sm' | 'md'
}) {
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set([value])}
      onSelectionChange={(keys: Set<Key>) => {
        const next = options.find((option) => keys.has(option.id))
        if (next) onChange(next.id)
      }}
      size={size}
    >
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

/** Any number of options toggled independently, e.g. filter chips. */
export function MultiToggle<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  options: readonly { id: T; label: ReactNode }[]
  value: readonly T[]
  onChange: (value: T[]) => void
  'aria-label': string
}) {
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      selectionMode="multiple"
      selectedKeys={new Set(value)}
      onSelectionChange={(keys: Set<Key>) =>
        onChange(options.filter((o) => keys.has(o.id)).map((o) => o.id))
      }
      size="sm"
      className="flex-wrap"
    >
      {options.map((option) => (
        <ToggleButton key={option.id} id={option.id}>
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
