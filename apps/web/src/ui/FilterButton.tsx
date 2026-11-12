import { ListBox, Popover } from '@heroui/react'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

import { filterLabel } from '../lib/filter-label.ts'
import { Button } from './Button.tsx'

/**
 * One choice of a `FilterButton`.
 *
 * @public
 */
export interface FilterOption {
  id: string
  label: string
}

/**
 * A "Label: Value" button that opens a multi-select list (one choice with `single`). It reads
 * "Label: Any" with nothing chosen, "Label: A, B" for two values and "Label: A, B +N" beyond
 * that; `value` keeps the order of `options`.
 *
 * @public
 */
export function FilterButton({
  label,
  options,
  value,
  onChange,
  all = 'Any',
  icon,
  single,
  className,
}: {
  label: string
  options: readonly FilterOption[]
  /** Chosen option ids; empty means no filter. */
  value: readonly string[]
  onChange: (value: string[]) => void
  /** Text shown with nothing chosen. */
  all?: string
  icon?: ReactNode
  /** At most one option is chosen; picking another replaces it. */
  single?: boolean
  className?: string
}) {
  const chosen = options.filter((option) => value.includes(option.id))
  const pick = (ids: Iterable<string>) => {
    const set = new Set(ids)
    onChange(options.filter((option) => set.has(option.id)).map((option) => option.id))
  }
  return (
    <Popover>
      <Button variant="secondary" className={className ?? ''}>
        {icon}
        <span className="truncate">
          {filterLabel(
            label,
            chosen.map((option) => option.label),
            { all },
          )}
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0" />
      </Button>
      <Popover.Content placement="bottom start" className="min-w-48">
        <Popover.Dialog aria-label={label} className="flex flex-col gap-1 p-1">
          <ListBox
            aria-label={label}
            selectionMode={single ? 'single' : 'multiple'}
            selectedKeys={new Set(chosen.map((option) => option.id))}
            onSelectionChange={(keys) =>
              pick(keys === 'all' ? options.map((option) => option.id) : [...keys].map(String))
            }
            className="max-h-72 overflow-auto"
          >
            {options.map((option) => (
              <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                {option.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
          {chosen.length ? (
            <Button variant="ghost" size="sm" onPress={() => onChange([])}>
              Clear
            </Button>
          ) : null}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}
