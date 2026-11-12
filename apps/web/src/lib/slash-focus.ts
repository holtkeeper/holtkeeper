/** The parts of a key event that decide whether `/` jumps to a search field. */
export interface SlashKey {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  /** The event already did something else, e.g. a focused widget handled it. */
  defaultPrevented?: boolean
  /** The key went to a text field, a select or contenteditable content. */
  editable?: boolean
}

/** True when `/` should focus the page's search field instead of typing. */
export const isSlashFocus = (event: SlashKey): boolean =>
  event.key === '/' &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.defaultPrevented &&
  !event.editable

const typeless = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** True for elements that take typed text: text-like inputs, textareas, selects and contenteditable. */
export function isEditableElement(element: {
  tagName: string
  isContentEditable?: boolean
  type?: string | undefined
}): boolean {
  if (element.isContentEditable) return true
  const tag = element.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  return tag === 'INPUT' && !typeless.has((element.type ?? 'text').toLowerCase())
}

/** `isEditableElement` for a key event's target; false for anything that is not an element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof target !== 'object' || target === null || !('tagName' in target)) return false
  const element = target as { tagName: unknown; isContentEditable?: boolean; type?: unknown }
  if (typeof element.tagName !== 'string') return false
  return isEditableElement({
    tagName: element.tagName,
    isContentEditable: element.isContentEditable === true,
    type: typeof element.type === 'string' ? element.type : undefined,
  })
}
