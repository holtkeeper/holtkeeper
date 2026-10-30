import { motion } from 'motion/react'
import type { ReactNode } from 'react'

/** A page with a title row and a fade-in on mount. */
export function Page({
  title,
  description,
  actions,
  eyebrow,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
  children: ReactNode
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="mx-auto flex w-full max-w-7xl flex-col gap-6"
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-1 text-sm text-muted">{eyebrow}</div> : null}
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </motion.div>
  )
}

/** Stagger container for lists and grids; children use `fadeItem`. */
export const stagger = {
  initial: 'hidden',
  animate: 'shown',
  variants: { hidden: {}, shown: { transition: { staggerChildren: 0.04 } } },
} as const

/** Variants for items inside a `stagger` container. */
export const fadeItem = {
  variants: { hidden: { opacity: 0, y: 6 }, shown: { opacity: 1, y: 0 } },
} as const
