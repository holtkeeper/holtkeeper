import type { Block, TimelineItem } from '@holtkeeper/api'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { formatDateTime, formatRelative } from '../../../lib/format.ts'
import { toneColor } from '../../../lib/units.ts'
import { LoadMore } from '../../../ui/index.ts'

const initialLimit = 60

function Entry({ item, nested = false }: { item: TimelineItem; nested?: boolean }) {
  const [open, setOpen] = useState(false)
  const count = item.children?.length ?? 0
  const valid = !Number.isNaN(Date.parse(item.at))
  return (
    <motion.li layout="position" className="relative">
      <span
        aria-hidden
        className={`absolute top-1.5 rounded-full border-2 border-surface ${nested ? '-left-[1.15rem] size-2' : '-left-[1.45rem] size-3'}`}
        style={{ background: toneColor[item.tone ?? 'neutral'] }}
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {item.href ? (
          <a
            href={item.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
          >
            {item.title}
            <ExternalLink className="size-3 text-muted" />
          </a>
        ) : (
          <span className="text-sm font-medium">{item.title}</span>
        )}
        {count ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} ${count} grouped entries`}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 rounded-full bg-default px-2 py-0.5 text-[11px] font-semibold tabular hover:bg-default-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            ×{count}
            <motion.span animate={{ rotate: open ? 180 : 0 }} className="inline-flex">
              <ChevronDown className="size-3" />
            </motion.span>
          </button>
        ) : null}
        {item.tags?.map((tag) => (
          <span
            key={tag}
            className="rounded-md bg-default-soft px-1.5 py-0.5 text-[11px] text-muted"
          >
            {tag}
          </span>
        ))}
        {valid ? (
          <time
            dateTime={item.at}
            title={formatDateTime(item.at)}
            className="ml-auto text-xs text-muted"
          >
            {formatRelative(item.at)}
          </time>
        ) : null}
      </div>
      {item.subtitle ? <div className="text-xs text-muted">{item.subtitle}</div> : null}
      <AnimatePresence initial={false}>
        {open && count ? (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-2 flex flex-col gap-2 overflow-hidden border-l border-dashed border-separator pl-4"
          >
            {item.children?.map((child) => (
              <Entry key={child.id} item={child} nested />
            ))}
          </motion.ol>
        ) : null}
      </AnimatePresence>
    </motion.li>
  )
}

/** Events in order, with duplicates or details folded under a `×N` badge. */
export function TimelineBlock({ block }: { block: Extract<Block, { type: 'timeline' }> }) {
  const [limit, setLimit] = useState(initialLimit)
  if (block.items.length === 0) return <p className="text-sm text-muted">No entries.</p>
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3 border-l border-separator pl-5">
        {block.items.slice(0, limit).map((item) => (
          <Entry key={item.id} item={item} />
        ))}
      </ol>
      {block.items.length > limit ? (
        <LoadMore size="sm" onLoad={() => setLimit((l) => l + initialLimit * 3)}>
          Show {Math.min(block.items.length - limit, initialLimit * 3)} more
        </LoadMore>
      ) : null}
    </div>
  )
}
