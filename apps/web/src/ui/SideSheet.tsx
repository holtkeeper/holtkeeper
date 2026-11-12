import { Link, type LinkProps } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronUp,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Copy,
  Maximize2,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'

import {
  type SheetSize,
  readSheetWidths,
  sheetIsWide,
  writeSheetWidth,
} from '../lib/sheet-width.ts'
import { sheetCommand, sheetPosition } from '../lib/sheet.ts'
import { isEditableTarget } from '../lib/slash-focus.ts'
import { Button, buttonClass } from './Button.tsx'
import { notify, Tooltip } from './Misc.tsx'
import { type MoreMenuItem, MoreMenu } from './MoreMenu.tsx'
import { type Segment, SegmentBar } from './SegmentBar.tsx'
import { useShell } from './shell.ts'
import { type UnderlineTab, UnderlineTabs } from './UnderlineTabs.tsx'

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    notify.success('Copied')
  } catch {
    notify.error('Not copied', 'The browser did not allow the clipboard.')
  }
}

const narrowQuery = '(max-width: 760px)'

const subscribeNarrow = (onChange: () => void) => {
  const query = window.matchMedia(narrowQuery)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const useNarrow = () =>
  useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  )

/** A labelled quiet button in the row under the sheet's title, e.g. "Run again". */
interface SheetAction {
  label: string
  icon: ComponentType<{ className?: string }>
  onPress: () => void
}

/** The first two of `actions` as `SideSheet` quiet actions; `undefined` when there are none. */
export function quietActionsOf(
  actions: readonly SheetAction[],
): readonly [SheetAction] | readonly [SheetAction, SheetAction] | undefined {
  const [first, second] = actions
  if (!first) return undefined
  return second ? [first, second] : [first]
}

interface SideSheetProps {
  open: boolean
  onClose: () => void
  /** Record id shown in monospace before the title, e.g. a job id or a hash. */
  id?: ReactNode
  /** Text a copy button next to `id` puts on the clipboard. */
  copyId?: string
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
  /** At most two labelled buttons in a row under the header. */
  quietActions?: readonly [SheetAction] | readonly [SheetAction, SheetAction]
  /** Secondary actions behind a "⋯" button at the end of the quiet actions row. */
  more?: readonly MoreMenuItem[]
  /** The record's own page; adds an "Open as page" link. */
  openAsPage?: LinkProps
  /** A segmented status bar in the header with a muted caption, e.g. "Step 5 of 7 · Agent patch". */
  progress?: { segments: readonly Segment[]; total?: number; label: ReactNode }
  /** Underline tabs between the header and the body. */
  tabs?: {
    items: readonly UnderlineTab[]
    selected?: string
    onSelect?: (id: string) => void
    'aria-label'?: string
  }
  /** Actions pinned under the body, e.g. a wizard's Back and Continue. */
  footer?: ReactNode
  /**
   * `wide` (up to 760px) for records with a lot of data; the viewer can widen or narrow any sheet
   * from its header, and that choice is remembered per size.
   */
  size?: SheetSize
  children: ReactNode
}

/**
 * A record opened from a list, drawn as a card in the shell's side-sheet slot beside the main
 * card, so the list stays visible and usable (on narrow screens it covers the page and acts as a
 * modal). Opening moves focus to its title and closing returns it. J and K step through the list
 * and Escape closes, except while typing in a field.
 * The header can carry a copy-id button, an "Open as page" link, a segmented progress bar, a row of
 * two quiet actions with a "⋯" menu, underline tabs, and a footer for actions.
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
  copyId,
  quietActions,
  more,
  openAsPage,
  progress,
  tabs,
  footer,
  size = 'default',
  children,
}: SideSheetProps) {
  const { sheet: slot } = useShell()
  const [wide, setWide] = useState(() => sheetIsWide(size, readSheetWidths()))
  const toggleWidth = () => {
    writeSheetWidth(size, !wide)
    setWide(!wide)
  }
  const heading = useRef<HTMLHeadingElement>(null)
  const narrow = useNarrow()
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const command = sheetCommand({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditableTarget(event.target),
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

  const shown = open && slot !== null

  useEffect(() => {
    const opener =
      shown && document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (shown) heading.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [shown])

  useEffect(() => {
    const behind =
      shown && narrow ? [...document.querySelectorAll<HTMLElement>('.shell-main, .shell-rail')] : []
    for (const element of behind) element.inert = true
    return () => {
      for (const element of behind) element.inert = false
    }
  }, [shown, narrow])

  if (!slot) return null
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.aside
          role="dialog"
          aria-modal={narrow}
          aria-label={typeof title === 'string' ? title : 'Details'}
          initial={{ x: 16, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 16, opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          data-sheet-size={wide ? 'wide' : 'default'}
          className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel"
        >
          <header className="flex shrink-0 flex-col border-b border-line">
            <div className="flex h-11 items-center gap-2 pl-4 pr-2">
              {id !== undefined ? (
                <span className="mono shrink-0 text-xs text-muted">{id}</span>
              ) : null}
              {copyId !== undefined ? (
                <Tooltip content="Copy id">
                  <Button
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    aria-label="Copy id"
                    onPress={() => void copy(copyId)}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </Tooltip>
              ) : null}
              <h2
                ref={heading}
                tabIndex={-1}
                className="min-w-0 flex-1 truncate text-[13px] font-semibold focus:outline-none"
              >
                {title}
              </h2>
              {index !== undefined && total !== undefined ? (
                <span className="mono shrink-0 text-xs text-dim">
                  {sheetPosition(index, total)}
                </span>
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
              {narrow ? null : (
                <Tooltip content={wide ? 'Narrower' : 'Wider'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    isIconOnly
                    aria-label={wide ? 'Make the sheet narrower' : 'Make the sheet wider'}
                    aria-pressed={wide}
                    onPress={toggleWidth}
                  >
                    {wide ? (
                      <ChevronsRightLeft className="size-4" />
                    ) : (
                      <ChevronsLeftRight className="size-4" />
                    )}
                  </Button>
                </Tooltip>
              )}
              {openAsPage ? (
                <Tooltip content="Open as page">
                  <Link
                    {...openAsPage}
                    aria-label="Open as page"
                    className={buttonClass('ghost', 'sm', 'w-8 min-w-8 px-0')}
                  >
                    <Maximize2 className="size-4" />
                  </Link>
                </Tooltip>
              ) : null}
              <Tooltip content="Close (Esc)">
                <Button variant="ghost" size="sm" isIconOnly aria-label="Close" onPress={onClose}>
                  <X className="size-4" />
                </Button>
              </Tooltip>
            </div>
            {progress ? (
              <div className="flex items-center gap-2.5 px-4 pb-2.5">
                <SegmentBar
                  segments={progress.segments}
                  {...(progress.total !== undefined ? { total: progress.total } : {})}
                  className="min-w-0 flex-1"
                />
                <span className="shrink-0 whitespace-nowrap text-xs text-muted">
                  {progress.label}
                </span>
              </div>
            ) : null}
            {quietActions?.length || more?.length ? (
              <div className="flex items-center gap-2 px-4 pb-3">
                {quietActions?.map((action) => (
                  <Button key={action.label} variant="secondary" size="sm" onPress={action.onPress}>
                    <action.icon className="size-3.5" />
                    {action.label}
                  </Button>
                ))}
                <span className="flex-1" />
                {more?.length ? <MoreMenu items={more} /> : null}
              </div>
            ) : null}
          </header>
          {tabs ? (
            <UnderlineTabs
              items={tabs.items}
              aria-label={tabs['aria-label'] ?? 'Sections'}
              className="shrink-0"
              {...(tabs.selected !== undefined ? { selected: tabs.selected } : {})}
              {...(tabs.onSelect ? { onSelect: tabs.onSelect } : {})}
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          {footer ? (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
              {footer}
            </footer>
          ) : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>,
    slot,
  )
}
