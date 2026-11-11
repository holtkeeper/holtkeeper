import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useEffect, useEffectEvent } from 'react'

import { sheetCommand, sheetPosition } from '../lib/sheet.ts'
import { Button } from './Button.tsx'
import { Tooltip } from './Misc.tsx'

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

interface SideSheetProps {
  open: boolean
  onClose: () => void
  /** Record id shown in monospace before the title, e.g. a job id or a hash. */
  id?: ReactNode
  title: ReactNode
  /** Zero-based position of the record in the list behind the sheet; shown as "3 of 41". */
  index?: number
  total?: number
  /** Called on K or the up button; leave out at the start of the list. */
  onPrevious?: () => void
  /** Called on J or the down button; leave out at the end of the list. */
  onNext?: () => void
  /** Controls shown in the header before the navigation buttons. */
  actions?: ReactNode
  children: ReactNode
}

/**
 * A record opened from a list, docked on the right without a backdrop so the list stays visible
 * and usable. J and K step through the list and Escape closes, except while typing in a field.
 *
 * @public
 */
export function SideSheet({
  open,
  onClose,
  id,
  title,
  index,
  total,
  onPrevious,
  onNext,
  actions,
  children,
}: SideSheetProps) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const command = sheetCommand({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditable(event.target),
    })
    const run =
      command === 'close'
        ? onClose
        : command === 'next'
          ? onNext
          : command === 'previous'
            ? onPrevious
            : undefined
    if (!run) return
    event.preventDefault()
    run()
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    if (open) window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open])

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          role="dialog"
          aria-modal="false"
          aria-label={typeof title === 'string' ? title : 'Details'}
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 32, opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-panel sm:w-[min(600px,92vw)]"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
            {id !== undefined ? (
              <span className="mono shrink-0 text-xs text-muted">{id}</span>
            ) : null}
            <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</h2>
            {index !== undefined && total !== undefined ? (
              <span className="mono shrink-0 text-xs text-dim">{sheetPosition(index, total)}</span>
            ) : null}
            {actions}
            <Tooltip content="Previous (K)">
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="Previous record"
                isDisabled={!onPrevious}
                {...(onPrevious ? { onPress: onPrevious } : {})}
              >
                <ChevronUp className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Next (J)">
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="Next record"
                isDisabled={!onNext}
                {...(onNext ? { onPress: onNext } : {})}
              >
                <ChevronDown className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Close (Esc)">
              <Button variant="ghost" size="sm" isIconOnly aria-label="Close" onPress={onClose}>
                <X className="size-4" />
              </Button>
            </Tooltip>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  )
}
