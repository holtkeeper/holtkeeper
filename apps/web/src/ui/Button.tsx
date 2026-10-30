import { Button as HeroButton, buttonVariants } from '@heroui/react'
import { Link, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/** Visual weight of a button, from most to least prominent. */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'danger-soft'

export interface ButtonProps {
  children?: ReactNode
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  onPress?: () => void
  type?: 'button' | 'submit' | 'reset'
  isDisabled?: boolean
  isPending?: boolean
  isIconOnly?: boolean
  fullWidth?: boolean
  className?: string
  form?: string
  'aria-label'?: string
  autoFocus?: boolean
}

/** A pressable button; keyboard and touch friendly. */
export function Button({ isPending, isDisabled, children, ...props }: ButtonProps) {
  return (
    <HeroButton
      {...props}
      isDisabled={isDisabled === true || isPending === true}
      isPending={isPending === true}
    >
      {children}
    </HeroButton>
  )
}

/** Class names that make any element look like a `Button`. */
export const buttonClass = (
  variant: ButtonVariant = 'secondary',
  size: 'sm' | 'md' | 'lg' = 'md',
  className = '',
) => `${buttonVariants({ variant, size })} ${className}`

/** A router link that looks like a button. */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: LinkProps & {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children: ReactNode
}) {
  return (
    <Link {...props} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  )
}
