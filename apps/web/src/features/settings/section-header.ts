import { type ComponentType, createContext, useContext, useEffect, useRef } from 'react'

import type { MoreMenuItem } from '../../ui/index.ts'

/** The primary action a Settings section body puts in the page header. */
interface SectionPrimary {
  label: string
  icon?: ComponentType<{ className?: string }>
  onPress: () => void
  isDisabled?: boolean
}

/** What a Settings section body adds to the page header: its one primary and ⋯ entries. */
export interface SectionHeader {
  primary?: SectionPrimary
  more?: readonly MoreMenuItem[]
}

/** Receives the header the open section's body asks for; `undefined` clears it. */
export const SectionHeaderContext = createContext<(header: SectionHeader | undefined) => void>(
  () => {},
)

/**
 * Puts `header` in the Settings page header while the calling body is mounted. The header is
 * re-sent only when its labels or disabled states change; presses always reach the newest
 * callbacks.
 */
export function useSectionHeader(header: SectionHeader | undefined): void {
  const set = useContext(SectionHeaderContext)
  const latest = useRef(header)
  useEffect(() => {
    latest.current = header
  })
  const signature = JSON.stringify([
    header?.primary?.label,
    header?.primary?.isDisabled,
    header?.more?.map((item) => [item.label, item.href, item.isDisabled]),
  ])
  useEffect(() => {
    const current = latest.current
    if (!current) return set(undefined)
    set({
      ...(current.primary && {
        primary: { ...current.primary, onPress: () => latest.current?.primary?.onPress() },
      }),
      ...(current.more && {
        more: current.more.map((item, index) =>
          item.onAction
            ? { ...item, onAction: () => latest.current?.more?.[index]?.onAction?.() }
            : item,
        ),
      }),
    })
    return () => set(undefined)
  }, [signature, set])
}
