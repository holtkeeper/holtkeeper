import { type ReactNode, useEffect, useRef } from 'react'

import { shouldAutoLoad } from '../lib/load-more.ts'
import { Button, type ButtonVariant } from './Button.tsx'

/**
 * A "show more" button that also presses itself when it scrolls into view, including inside a
 * scrolling table. It presses itself once per time it comes into view and never while
 * `isPending`; a button that stays on screen after a page arrives waits for a click.
 */
export function LoadMore({
  onLoad,
  isPending,
  children,
  variant = 'secondary',
  size,
  className,
}: {
  onLoad: () => void
  isPending?: boolean
  children: ReactNode
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const load = useRef(onLoad)
  load.current = onLoad
  const pending = useRef(isPending ?? false)
  pending.current = isPending ?? false

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    let visible = false
    const observer = new IntersectionObserver(
      (entries) => {
        const now = entries.some((entry) => entry.isIntersecting)
        const fire = shouldAutoLoad(visible, now, pending.current)
        visible = now
        if (fire) load.current()
      },
      { rootMargin: '0px 0px 200px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={className ?? 'flex justify-center'}>
      <Button variant={variant} {...(size ? { size } : {})} onPress={onLoad} isPending={isPending}>
        {children}
      </Button>
    </div>
  )
}
