import { Chip as HeroChip } from '@heroui/react'
import type { ReactNode } from 'react'

/** Semantic color of a chip. */
export type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger'

/** A small label for states and categories. */
export function Chip({
  tone = 'default',
  variant = 'soft',
  size = 'sm',
  children,
  className,
}: {
  tone?: Tone
  variant?: 'primary' | 'secondary' | 'soft' | 'tertiary'
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
  className?: string
}) {
  return (
    <HeroChip color={tone} variant={variant} size={size} className={className}>
      {children}
    </HeroChip>
  )
}
