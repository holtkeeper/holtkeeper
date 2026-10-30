import { Tabs as HeroTabs } from '@heroui/react'
import type { Key, ReactNode } from 'react'

export interface TabItem {
  id: string
  label: ReactNode
  content: ReactNode
}

/** Tabbed sections; arrow keys move between tabs. */
export function Tabs({
  items,
  selected,
  onSelect,
  'aria-label': ariaLabel,
}: {
  items: readonly TabItem[]
  selected?: string
  onSelect?: (id: string) => void
  'aria-label': string
}) {
  return (
    <HeroTabs
      {...(selected !== undefined ? { selectedKey: selected } : {})}
      {...(onSelect ? { onSelectionChange: (key: Key) => onSelect(String(key)) } : {})}
      className="flex flex-col gap-4"
    >
      <HeroTabs.ListContainer className="overflow-x-auto">
        <HeroTabs.List aria-label={ariaLabel}>
          {items.map((item) => (
            <HeroTabs.Tab key={item.id} id={item.id} className="whitespace-nowrap">
              {item.label}
              <HeroTabs.Indicator />
            </HeroTabs.Tab>
          ))}
        </HeroTabs.List>
      </HeroTabs.ListContainer>
      {items.map((item) => (
        <HeroTabs.Panel key={item.id} id={item.id}>
          {item.content}
        </HeroTabs.Panel>
      ))}
    </HeroTabs>
  )
}
