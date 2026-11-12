import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

/** Opens or closes the command palette the app shell mounts. */
export const setPaletteOpen = (next: boolean): void => {
  if (open === next) return
  open = next
  for (const listener of listeners) listener()
}

/** Opens the command palette; a no-op outside the signed-in shell. */
export const openPalette = (): void => setPaletteOpen(true)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the command palette is open. */
export const usePaletteOpen = (): boolean => useSyncExternalStore(subscribe, () => open)
