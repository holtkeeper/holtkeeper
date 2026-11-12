import { createContext, use } from 'react'

import type { Crumb } from './Crumbs.tsx'
import type { SegmentedTab } from './SegmentedTabs.tsx'

/**
 * The current workspace: its pages, drawn by `Page` as segmented tabs when it gets no `tabs`, and
 * the title and crumb `Page` uses for its header.
 */
interface CurrentWorkspace {
  /** Accessible name of the tab row, e.g. "Supply pages". */
  label: string
  /** The workspace's name as page titles show it, e.g. "Supply chain". */
  title: string
  /** The first crumb of its pages, linking to the first page the viewer may open. */
  crumb: Crumb
  items: readonly SegmentedTab[]
  /** `id` of the tab of the current page, if any. */
  selected?: string
}

/** What the app shell offers the pages inside it. */
export interface ShellSlots {
  workspace?: CurrentWorkspace
  /** The element beside the main card that `SideSheet` renders into; `null` outside the shell. */
  sheet: HTMLElement | null
}

/** Provided by the app shell; outside it there are no workspace tabs and no sheet slot. */
export const ShellContext = createContext<ShellSlots>({ sheet: null })

/** The shell's workspace tabs and side-sheet slot. */
export const useShell = (): ShellSlots => use(ShellContext)
