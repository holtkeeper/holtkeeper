/** What a key press does in a side sheet. */
export type SheetCommand = 'next' | 'previous' | 'close'

/**
 * The command for a key press in a side sheet: J next, K previous, Escape close. Presses with a
 * modifier and presses while typing in a field do nothing, so text fields keep their keys.
 */
export const sheetCommand = (event: {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  editable?: boolean
}): SheetCommand | undefined => {
  if (event.key === 'Escape') return 'close'
  if (event.editable || event.altKey || event.ctrlKey || event.metaKey) return undefined
  if (event.key === 'j' || event.key === 'J') return 'next'
  if (event.key === 'k' || event.key === 'K') return 'previous'
  return undefined
}

/** "3 of 41" for a zero-based `index` in a list of `total` records. */
export const sheetPosition = (index: number, total: number): string =>
  `${(index + 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`

/** What a key press does in a list of decisions: a sheet command, or a decision on the open row. */
export type DecisionCommand = SheetCommand | 'approve' | 'reject' | 'snooze'

/**
 * `sheetCommand` plus A approve, R reject and S snooze, under the same rules: nothing while
 * typing in a field or with a modifier.
 */
export const decisionCommand = (
  event: Parameters<typeof sheetCommand>[0],
): DecisionCommand | undefined => {
  const command = sheetCommand(event)
  if (command || event.editable || event.altKey || event.ctrlKey || event.metaKey) return command
  const key = event.key.toLowerCase()
  return key === 'a' ? 'approve' : key === 'r' ? 'reject' : key === 's' ? 'snooze' : undefined
}
