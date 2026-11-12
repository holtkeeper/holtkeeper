/** How wide a side sheet opens: the 460px default, or wide for records with a lot of data. */
export type SheetSize = 'default' | 'wide'

const key = 'holtkeeper.sheet.width'

/**
 * Whether a sheet of `size` shows wide: the viewer's last choice for that size wins over the
 * size the page asked for.
 */
export const sheetIsWide = (
  size: SheetSize,
  stored: Partial<Record<SheetSize, boolean>>,
): boolean => stored[size] ?? size === 'wide'

/** The viewer's remembered choices per size; empty when storage is unavailable or unreadable. */
export function readSheetWidths(): Partial<Record<SheetSize, boolean>> {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '{}')
    if (!value || typeof value !== 'object') return {}
    const plain = 'default' in value ? value.default : undefined
    const wide = 'wide' in value ? value.wide : undefined
    return {
      ...(typeof plain === 'boolean' && { default: plain }),
      ...(typeof wide === 'boolean' && { wide }),
    }
  } catch {
    return {}
  }
}

/** Remembers whether sheets of `size` should show wide; silently skipped without storage. */
export function writeSheetWidth(size: SheetSize, wide: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify({ ...readSheetWidths(), [size]: wide }))
  } catch {}
}
