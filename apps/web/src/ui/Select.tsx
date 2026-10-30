import { Label, ListBox, Select as HeroSelect } from '@heroui/react'
import type { Key, ReactNode } from 'react'

export interface Option {
  id: string
  label: ReactNode
  /** Plain text for type-ahead when `label` is not a string. */
  text?: string
}

/** Single-choice dropdown. */
export function Select({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select…',
  className,
  isDisabled,
  ...rest
}: {
  label?: ReactNode
  'aria-label'?: string
  options: readonly Option[]
  value: string | undefined
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  isDisabled?: boolean
}) {
  return (
    <HeroSelect
      className={`flex flex-col gap-1 ${className ?? ''}`}
      placeholder={placeholder}
      value={value ?? null}
      onChange={(key: Key | null) => {
        if (key !== null) onChange(String(key))
      }}
      isDisabled={isDisabled === true}
      {...(rest['aria-label'] ? { 'aria-label': rest['aria-label'] } : {})}
    >
      {label ? <Label>{label}</Label> : null}
      <HeroSelect.Trigger>
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.id}
              id={option.id}
              textValue={
                option.text ?? (typeof option.label === 'string' ? option.label : option.id)
              }
            >
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  )
}
