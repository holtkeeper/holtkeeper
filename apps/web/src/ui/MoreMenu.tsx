import { Dropdown, buttonVariants } from '@heroui/react'
import { useRouter } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import type { ComponentType } from 'react'

import { moreMenuLabel } from '../lib/page-header.ts'

/** One entry of an overflow menu: runs `onAction`, or opens `href` (an app path) in place. */
export interface MoreMenuItem {
  label: string
  icon?: ComponentType<{ className?: string }>
  onAction?: () => void
  href?: string
  /** Destructive entries are drawn in the danger color. */
  danger?: boolean
  isDisabled?: boolean
}

/** The "⋯" button that holds a page's or a record's secondary actions; renders nothing when empty. */
export function MoreMenu({
  items,
  'aria-label': ariaLabel,
}: {
  items: readonly MoreMenuItem[]
  'aria-label'?: string
}) {
  const router = useRouter()
  if (!items.length) return null
  const run = (item: MoreMenuItem) => {
    if (item.onAction) item.onAction()
    else if (item.href) router.history.push(item.href)
  }
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={ariaLabel ?? moreMenuLabel(items.map((item) => item.label))}
        className={buttonVariants({ variant: 'ghost', size: 'sm', isIconOnly: true })}
      >
        <MoreHorizontal className="size-4" />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="More actions"
          disabledKeys={items.flatMap((item, index) => (item.isDisabled ? [String(index)] : []))}
          onAction={(key) => {
            const item = items[Number(key)]
            if (item) run(item)
          }}
        >
          {items.map((item, index) => (
            <Dropdown.Item
              key={index}
              id={String(index)}
              textValue={item.label}
              variant={item.danger ? 'danger' : 'default'}
            >
              {item.icon ? <item.icon className="size-3.5" /> : null}
              {item.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
