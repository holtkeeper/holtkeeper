import { type RefObject, useEffect } from 'react'

import { isEditableTarget, isSlashFocus } from '../lib/slash-focus.ts'

/**
 * Focuses and selects `ref`'s input when `/` is pressed anywhere on the page, unless the key
 * goes to an editable field or carries a modifier. Pass `enabled: false` to pause it.
 *
 * @public
 */
export function useSlashFocus(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (!isSlashFocus({ ...pick(event), editable: isEditableTarget(event.target) })) return
      const input = ref.current
      if (!input) return
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ref, enabled])
}

const pick = ({ key, altKey, ctrlKey, metaKey, defaultPrevented }: KeyboardEvent) => ({
  key,
  altKey,
  ctrlKey,
  metaKey,
  defaultPrevented,
})
