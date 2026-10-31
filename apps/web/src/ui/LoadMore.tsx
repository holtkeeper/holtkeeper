import { type ReactNode, useEffect, useRef } from 'react'

import { Button, type ButtonVariant } from './Button.tsx'

/**
 * A "show more" button that also presses itself once it scrolls into view, including inside a
 * scrolling table. It keeps loading while it stays visible and stops while `isPending`.
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

  useEffect(() => {
    const node = ref.current
    if (!node || isPending) return undefined
    let fired = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (fired || !entries.some((entry) => entry.isIntersecting)) return
        fired = true
        load.current()
      },
      { rootMargin: '0px 0px 200px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  })

  return (
    <div ref={ref} className={className ?? 'flex justify-center'}>
      <Button variant={variant} {...(size ? { size } : {})} onPress={onLoad} isPending={isPending}>
        {children}
      </Button>
    </div>
  )
}
