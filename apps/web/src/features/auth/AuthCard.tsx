import { BookText } from 'lucide-react'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'

import { BrandIcon, buttonClass } from '../../ui/index.ts'
import { docsUrl } from '../shell/nav.ts'
import { ThemeToggle } from '../shell/ThemeToggle.tsx'

/**
 * The page around sign-in, setup links and start-up states: a top strip with the brand, this
 * instance's host, Docs and the theme toggle, then a centered card with `title`, `subtitle` and
 * `children`; `footer` sits under the card.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-12 items-center gap-2.5 border-b border-line px-4">
        <BrandIcon className="size-5" />
        <span className="text-[13px] font-semibold">Holtkeeper</span>
        <span className="mono truncate text-xs text-dim">{window.location.host}</span>
        <span className="flex-1" />
        <a href={docsUrl} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'sm')}>
          <BookText className="size-3.5" />
          Docs
        </a>
        <ThemeToggle />
      </header>
      <div className="grid flex-1 place-items-center px-4 py-10">
        <div className="flex w-full max-w-sm flex-col gap-4">
          <motion.main
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="w-full rounded-[12px] border border-line bg-panel p-7"
          >
            <div className="mb-6 flex flex-col items-center gap-3 text-center">
              <BrandIcon className="size-12" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
              </div>
            </div>
            {children}
          </motion.main>
          {footer ? <div className="text-center text-xs text-dim">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}
