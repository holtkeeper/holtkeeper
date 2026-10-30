import { Kbd as HeroKbd, SearchField, Toast, Tooltip as HeroTooltip, toast } from '@heroui/react'
import { Check, Copy } from 'lucide-react'
import { type ReactNode, type Ref, useState } from 'react'

import { Button } from './Button.tsx'

/** Search box with a clear button; Escape clears. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  'aria-label': ariaLabel,
  inputRef,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label': string
  inputRef?: Ref<HTMLInputElement>
  className?: string
}) {
  return (
    <SearchField value={value} onChange={onChange} aria-label={ariaLabel} className={className}>
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input placeholder={placeholder} {...(inputRef ? { ref: inputRef } : {})} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  )
}

/** Hover and focus hint. The trigger must be focusable for keyboard users to see it. */
export function Tooltip({
  content,
  children,
  delay = 400,
}: {
  content: ReactNode
  children: ReactNode
  delay?: number
}) {
  return (
    <HeroTooltip delay={delay}>
      <HeroTooltip.Trigger>{children}</HeroTooltip.Trigger>
      <HeroTooltip.Content showArrow>
        <HeroTooltip.Arrow />
        {content}
      </HeroTooltip.Content>
    </HeroTooltip>
  )
}

/** Keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <HeroKbd>
      <HeroKbd.Content>{children}</HeroKbd.Content>
    </HeroKbd>
  )
}

/** Toast notifications; render `ToastHost` once near the root. */
export const notify = {
  success: (message: ReactNode, description?: ReactNode) =>
    toast.success(message, description ? { description } : {}),
  error: (message: ReactNode, description?: ReactNode) =>
    toast.danger(message, { ...(description ? { description } : {}), timeout: 8000 }),
  info: (message: ReactNode, description?: ReactNode) =>
    toast.info(message, description ? { description } : {}),
}

export function ToastHost() {
  return <Toast.Provider placement="bottom end" />
}

/** Read-only value with a copy button, for links and tokens shown once. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="flex items-stretch gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-border bg-default px-3 py-2 font-mono text-[13px]"
      >
        {value}
      </code>
      <Button
        variant="secondary"
        isIconOnly
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        onPress={() => void copy()}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}
