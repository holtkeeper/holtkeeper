import {
  Checkbox as HeroCheckbox,
  Description,
  FieldError,
  Input,
  Label,
  Switch as HeroSwitch,
  TextArea,
  TextField as HeroTextField,
} from '@heroui/react'
import type { ReactNode } from 'react'

export interface TextFieldProps {
  label?: ReactNode
  'aria-label'?: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password' | 'url' | 'email' | 'date' | 'number' | 'search'
  placeholder?: string
  description?: ReactNode
  /** Shown below the field and marks it invalid. */
  error?: string | undefined
  isRequired?: boolean
  isDisabled?: boolean
  autoFocus?: boolean
  autoComplete?: string
  name?: string
  multiline?: boolean
  rows?: number
  mono?: boolean
  className?: string
  onKeyDown?: (event: React.KeyboardEvent) => void
  min?: number
  max?: number
}

/** Labelled text input (or textarea with `multiline`) with description and error. */
export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  description,
  error,
  isRequired,
  isDisabled,
  autoFocus,
  autoComplete,
  name,
  multiline,
  rows = 6,
  mono,
  className,
  onKeyDown,
  min,
  max,
  ...rest
}: TextFieldProps) {
  const fieldClass = mono ? 'font-mono text-[13px]' : undefined
  return (
    <HeroTextField
      value={value}
      onChange={onChange}
      type={type}
      isInvalid={error !== undefined}
      isRequired={isRequired === true}
      isDisabled={isDisabled === true}
      className={`flex flex-col gap-1 ${className ?? ''}`}
      {...(name ? { name } : {})}
      {...(autoComplete ? { autoComplete } : {})}
      {...(rest['aria-label'] ? { 'aria-label': rest['aria-label'] } : {})}
    >
      {label ? <Label>{label}</Label> : null}
      {multiline ? (
        <TextArea
          placeholder={placeholder}
          rows={rows}
          className={fieldClass}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
      ) : (
        <Input
          placeholder={placeholder}
          className={fieldClass}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
          min={min}
          max={max}
        />
      )}
      {description && error === undefined ? <Description>{description}</Description> : null}
      <FieldError>{error}</FieldError>
    </HeroTextField>
  )
}

/** On/off toggle with a label. */
export function Switch({
  label,
  isSelected,
  onChange,
  isDisabled,
  description,
}: {
  label: ReactNode
  isSelected: boolean
  onChange: (selected: boolean) => void
  isDisabled?: boolean
  description?: ReactNode
}) {
  return (
    <HeroSwitch isSelected={isSelected} onChange={onChange} isDisabled={isDisabled === true}>
      <HeroSwitch.Content>
        <HeroSwitch.Control>
          <HeroSwitch.Thumb />
        </HeroSwitch.Control>
        <Label>{label}</Label>
      </HeroSwitch.Content>
      {description ? <Description>{description}</Description> : null}
    </HeroSwitch>
  )
}

/** Checkbox with a label. */
export function Checkbox({
  label,
  isSelected,
  onChange,
  isDisabled,
  className,
}: {
  label: ReactNode
  isSelected: boolean
  onChange: (selected: boolean) => void
  isDisabled?: boolean
  className?: string
}) {
  return (
    <HeroCheckbox
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled === true}
      className={className}
    >
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{label}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  )
}
