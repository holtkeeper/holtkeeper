import { motion } from 'motion/react'
import type { ReactNode } from 'react'

import { BrandIcon } from '../../ui/index.ts'
import { ThemeToggle } from '../shell/ThemeToggle.tsx'

/** Centered card used by the sign-in and link pages. */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="app-backdrop relative grid min-h-screen place-items-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <motion.main
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        className="w-full max-w-sm rounded-3xl border border-border bg-surface p-8 shadow-overlay"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandIcon name="holtkeeper" className="size-16" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
        </div>
        {children}
      </motion.main>
    </div>
  )
}
